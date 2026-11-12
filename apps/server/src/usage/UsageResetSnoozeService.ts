import {
  type UsageResetSnooze,
  UsageResetSnoozeError,
  type UsageResetSnoozeInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import { accountResetAtMs, soonestHubReset } from "./usageResetSnooze.ts";

const ROUTER_PROVIDERS = { claudeAgent: "claude", codex: "codex" } as const;

/** Fork: when a thread's next message could run again, for "Snooze until usage resets". */
export const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const resolve = Effect.fn("UsageResetSnooze.resolve")(function* (input: UsageResetSnoozeInput) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const { instanceId, model } = input.modelSelection;
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (!provider) {
      return yield* new UsageResetSnoozeError({ detail: "That provider is not available." });
    }
    const done = (resetsAtMs: number, rest: Omit<UsageResetSnooze, "resetsAt">) => ({
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)),
      ...rest,
    });

    // Behind a hub, streamed windows describe whichever account served the last turn, so only
    // the hub can say which account comes next. Claude marks a gateway as a custom endpoint;
    // Codex marks native usage unsupported for custom providers (not for direct API keys).
    const own = provider.usageLimits;
    const behindHub =
      provider.auth.type === "customEndpoint" ||
      (own?.unavailable?.reason === "unsupported" && provider.auth.type !== "apiKey");
    if (!behindHub) {
      const resetsAtMs =
        own && own.windows.length > 0 ? accountResetAtMs(provider.driver, own, model, now) : null;
      if (resetsAtMs === null) {
        return yield* new UsageResetSnoozeError({
          detail: "This account has not reported when its usage resets.",
        });
      }
      return done(resetsAtMs, { basis: "account" });
    }

    // Hub settings do not name the provider endpoint they serve, so only a single hub holding
    // this provider's accounts identifies where the thread's requests go.
    const hubs = (yield* sources.current).filter((source) =>
      source.accounts.some((account) => account.driver === provider.driver),
    );
    const routerProvider = Object.hasOwn(ROUTER_PROVIDERS, provider.driver)
      ? ROUTER_PROVIDERS[provider.driver as keyof typeof ROUTER_PROVIDERS]
      : undefined;
    if (hubs.length === 1 && routerProvider !== undefined) {
      // The router binds accounts to native sessions; a switch not yet sent or an armed fresh
      // session starts a new one.
      const target =
        input.freshContext === true
          ? undefined
          : yield* orchestrator
              .resolveMessageProviderThread(input.threadId, input.modelSelection)
              .pipe(Effect.orElseSucceed(() => undefined));
      const session = target?.nativeThreadRef?.nativeId;
      const pick = yield* sources.nextPickReset({
        sourceId: hubs[0]!.id,
        provider: routerProvider,
        model,
        ...(session ? { session } : {}),
      });
      if (pick !== null) {
        const resetsAtMs = pick.resetsAt === null ? Number.NaN : Date.parse(pick.resetsAt);
        // Never another account's reset: the router named the account it will use.
        if (!(resetsAtMs > now)) {
          return yield* new UsageResetSnoozeError({
            detail: "The CLI Proxy account this thread will use has not reported its reset.",
          });
        }
        return done(resetsAtMs, { basis: "router" });
      }
    }

    const soonest = soonestHubReset(
      hubs.flatMap((source) =>
        source.accounts.filter((account) => account.driver === provider.driver),
      ),
      model,
      now,
    );
    if (soonest === null) {
      return yield* new UsageResetSnoozeError({
        detail: "No usage reset time is known for this provider.",
      });
    }
    return done(soonest.resetsAtMs, { basis: "soonest", accountLabel: soonest.accountLabel });
  });

  return { resolve };
});
