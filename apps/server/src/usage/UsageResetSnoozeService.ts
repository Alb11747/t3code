import {
  type ServerProviderUsageLimits,
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
    const { window } = input;
    // A chosen window counts only its own readings, so the reset is that window's.
    const scoped = (limits: ServerProviderUsageLimits | undefined) =>
      limits && window
        ? { ...limits, windows: limits.windows.filter((reading) => reading.kind === window) }
        : limits;
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
      const limits = scoped(own);
      const resetsAtMs =
        limits && limits.windows.length > 0
          ? accountResetAtMs(provider.driver, limits, model, now)
          : null;
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
        // The router names accounts as it does now; the snapshot's aliases can trail it.
        const rename = window ? yield* sources.routerAlias(hubs[0]!.id) : undefined;
        const last = rename
          ? hubs[0]!.accounts.find(
              (account) =>
                account.driver === provider.driver &&
                account.routerAlias !== undefined &&
                rename(account.routerAlias) === pick.lastAccount,
            )
          : undefined;
        const resetsAtMs = window
          ? ((last && accountResetAtMs(provider.driver, scoped(last.usageLimits), model, now)) ??
            Number.NaN)
          : pick.resetsAt === null
            ? Number.NaN
            : Date.parse(pick.resetsAt);
        // Never another account's reset: the router named the thread's account.
        if (!(resetsAtMs > now)) {
          return yield* new UsageResetSnoozeError({
            detail: window
              ? "The CLI Proxy account this thread last used has not reported when that limit resets."
              : "The CLI Proxy account this thread will use has not reported its reset.",
          });
        }
        return done(resetsAtMs, { basis: "router" });
      }
    }

    const soonest = soonestHubReset(
      hubs.flatMap((source) =>
        source.accounts.flatMap((account) =>
          account.driver === provider.driver
            ? [{ ...account, usageLimits: scoped(account.usageLimits) ?? account.usageLimits }]
            : [],
        ),
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
