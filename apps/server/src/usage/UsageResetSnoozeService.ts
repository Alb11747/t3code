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
import { accountResetAtMs, soonestHubReset, windowResets } from "./usageResetSnooze.ts";

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
    // The overall reset and each window's are separate answers: a window's reset still serves
    // when the overall one is unknown, but never stands in for it.
    const answer = (
      resetsAtMs: number | null,
      rest: Omit<UsageResetSnooze, "resetsAt">,
      unknown: string,
    ) => {
      const known = resetsAtMs !== null && resetsAtMs > now;
      if (!known && (rest.windows ?? []).length === 0) {
        return Effect.fail(new UsageResetSnoozeError({ detail: unknown }));
      }
      return Effect.succeed<UsageResetSnooze>({
        ...(known ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)) } : {}),
        ...rest,
      });
    };

    // Behind a hub, streamed windows describe whichever account served the last turn, so only
    // the hub can say which account comes next. Claude marks a gateway as a custom endpoint;
    // Codex marks native usage unsupported for custom providers (not for direct API keys).
    const own = provider.usageLimits;
    const behindHub =
      provider.auth.type === "customEndpoint" ||
      (own?.unavailable?.reason === "unsupported" && provider.auth.type !== "apiKey");
    if (!behindHub) {
      return yield* answer(
        own && own.windows.length > 0 ? accountResetAtMs(provider.driver, own, model, now) : null,
        { basis: "account", windows: windowResets(provider.driver, own, model, now) },
        "This account has not reported when its usage resets.",
      );
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
      // The router binds accounts to native sessions, so the session names the thread's account.
      const target = yield* orchestrator
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
        // Windows are those of the account the conversation is on, whose readings the hub has.
        // The router names accounts as it does now; the snapshot's aliases can trail it.
        const rename = yield* sources.routerAlias(hubs[0]!.id);
        const last = hubs[0]!.accounts.find(
          (account) =>
            account.driver === provider.driver &&
            account.routerAlias !== undefined &&
            rename(account.routerAlias) === pick.lastAccount,
        );
        // Never another account's overall reset: the router named the account it will use.
        return yield* answer(
          pick.resetsAt === null ? null : Date.parse(pick.resetsAt),
          {
            basis: "router",
            windows: last ? windowResets(provider.driver, last.usageLimits, model, now) : [],
          },
          "The CLI Proxy account this thread will use has not reported its reset.",
        );
      }
    }

    const candidates = hubs.flatMap((source) =>
      source.accounts.filter((account) => account.driver === provider.driver),
    );
    const soonest = soonestHubReset(candidates, model, now);
    // Only a lone account is surely the thread's, so only its windows can be offered.
    return yield* answer(
      soonest?.resetsAtMs ?? null,
      {
        basis: "soonest",
        ...(soonest ? { accountLabel: soonest.accountLabel } : {}),
        windows:
          candidates.length === 1
            ? windowResets(provider.driver, candidates[0]!.usageLimits, model, now)
            : [],
      },
      "No usage reset time is known for this provider.",
    );
  });

  return { resolve };
});
