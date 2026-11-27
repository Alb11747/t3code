import {
  CommandId,
  threadAccountChoiceFor,
  type OrchestrationV2AppThread,
  type ThreadId,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { controlExpiry } from "../provider/ThreadAccountRouting.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { routerProviderOf, type CliproxyApi, type CliproxyHub } from "./cliproxyApi.ts";
import { accountPace, pacedUntil } from "./pacedSessions.ts";
import { hubSourceOf } from "./ThreadAccountService.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const SWEEP_EVERY_MS = 60_000;
const RENEW_EVERY_MS = 6 * 60 * 60 * 1000;
// The router's pace time moves as use does; a hold moves only for a real change.
const HOLD_SLACK_MS = 5 * 60 * 1000;
const THREAD_TIMEOUT = "10 seconds";

type RouterControl = Effect.Success<ReturnType<CliproxyApi["control"]>>;

// Fork: the router holds a paced Claude thread's requests once its sessions are registered. A paced
// Codex thread gets a persisted `pacedUntil` while its account is ahead, which keeps its next turn
// queued (`canStartQueuedRun`), so a restart resumes it without an agent.
/** @public */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const providers = yield* ProviderRegistry.ProviderRegistry;

  // In memory: after a restart every paced session is posted again, which renews it.
  const registered = new Map<
    ThreadId,
    { readonly hub: CliproxyHub; readonly sessions: ReadonlyArray<string>; key: string; at: number }
  >();
  let kicked = true;
  let lastSweep = 0;

  const syncThread = Effect.fn("PacedThreads.syncThread")(function* (
    thread: OrchestrationV2AppThread,
    context: {
      readonly nowMs: number;
      readonly providerList: Effect.Success<
        ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
      >;
      readonly control: (
        sourceId: UsageLimitSourceId,
        hub: CliproxyHub,
      ) => Effect.Effect<RouterControl | null>;
    },
  ) {
    const { nowMs } = context;
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const paced = thread.archivedAt === null ? (thread.paced ?? null) : null;
    const instanceId = thread.modelSelection.instanceId;
    const provider = context.providerList.find((entry) => entry.instanceId === instanceId);
    const routerProvider = provider ? routerProviderOf(provider.driver) : undefined;
    const choice = threadAccountChoiceFor(thread.accountChoice, instanceId);
    const sourceId =
      choice?.sourceId ??
      (provider ? hubSourceOf(provider, yield* sources.current)?.id : undefined);
    const hub = sourceId === undefined ? null : yield* sources.hub(sourceId);
    const providerThreads = (yield* projections.getThreadRecords(thread.id, ["providerThreads"]))
      .providerThreads;

    const previous = registered.get(thread.id);
    if (routerProvider === "claude" && paced !== null && hub !== null) {
      const sessions = providerThreads.flatMap((providerThread) =>
        routerProviderOf(providerThread.driver) === "claude" &&
        providerThread.nativeThreadRef?.nativeId != null
          ? [providerThread.nativeThreadRef.nativeId]
          : [],
      );
      const key = [hub.url, sessions.join(","), paced.windows.join(",")].join("|");
      if (sessions.length > 0 && (previous?.key !== key || nowMs - previous.at >= RENEW_EVERY_MS)) {
        if (previous !== undefined && previous.hub.url !== hub.url) {
          yield* sources.unpace(previous.hub, previous.sessions).pipe(Effect.ignore);
        }
        yield* sources.pace(
          hub,
          sessions,
          paced.windows,
          controlExpiry(DateTime.makeUnsafe(nowMs)),
        );
        registered.set(thread.id, { hub, sessions, key, at: nowMs });
      }
    } else if (
      previous !== undefined &&
      (paced === null || (provider !== undefined && routerProvider !== "claude"))
    ) {
      yield* sources.unpace(previous.hub, previous.sessions);
      registered.delete(thread.id);
    }

    const current = thread.pacedUntil ?? null;
    // What T3 cannot read yet (providers still probing at startup, no hub, an unreadable router or
    // pick) keeps a hold until it ends, then lets the thread go on.
    const kept = current !== null && current > nowIso ? current : null;
    let until: string | null = null;
    if (paced !== null && provider === undefined) {
      until = kept;
    } else if (routerProvider === "codex" && paced !== null) {
      const control =
        hub === null || sourceId === undefined ? null : yield* context.control(sourceId, hub);
      const session = providerThreads.find(
        (providerThread) => providerThread.id === thread.activeProviderThreadId,
      )?.nativeThreadRef?.nativeId;
      const account =
        control === null || hub === null
          ? null
          : choice
            ? (yield* sources.routerAlias(choice.sourceId))(choice.account)
            : yield* sources
                .nextPick(hub, {
                  provider: "codex",
                  model: thread.modelSelection.model,
                  ...(session ? { session } : {}),
                })
                .pipe(Effect.map((pick) => pick?.current ?? pick?.owner ?? pick?.account ?? null));
      until =
        control === null || account === null
          ? kept
          : pacedUntil(accountPace(control.accounts, account), paced.windows, nowIso);
    }
    const moved =
      (until === null) !== (current === null) ||
      (until !== null &&
        current !== null &&
        Math.abs(Date.parse(until) - Date.parse(current)) > HOLD_SLACK_MS);
    // Clearing the hold starts the thread's queue (Orchestrator, on `pacedUntil: null`).
    if (moved) {
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`paced:${thread.id}:${until ?? "clear"}:${nowMs}`),
        threadId: thread.id,
        pacedUntil: until,
      });
    }
  });

  const sweep = Effect.fn("PacedThreads.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    kicked = false;
    lastSweep = nowMs;
    const threads = yield* projections.getPacedThreads();
    const seen = new Set(threads.map((thread) => thread.id));
    // A thread no longer paced drops out of the read: undo what it left behind.
    // A failed removal is retried next sweep; the router drops it at expiry anyway.
    for (const [threadId, registration] of registered) {
      if (seen.has(threadId)) continue;
      yield* sources.unpace(registration.hub, registration.sessions).pipe(
        Effect.andThen(Effect.sync(() => registered.delete(threadId))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not unpace a thread.", { threadId, cause }),
        ),
      );
    }
    if (threads.length === 0) return;
    const providerList = yield* providers.getProviders;
    // One router read per hub and sweep; a failed read counts as unknown.
    const controls = new Map<string, RouterControl | null>();
    const control = Effect.fnUntraced(function* (sourceId: UsageLimitSourceId, hub: CliproxyHub) {
      const known = controls.get(sourceId);
      if (known !== undefined) return known;
      const read = Option.getOrNull(
        yield* sources.control(sourceId, hub).pipe(Effect.timeout("5 seconds"), Effect.option),
      );
      controls.set(sourceId, read);
      return read;
    });
    yield* Effect.forEach(
      threads,
      (thread) =>
        syncThread(thread, { nowMs, providerList, control }).pipe(
          Effect.timeout(THREAD_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not keep a paced thread paced.", {
              threadId: thread.id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  });

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (!event.type.startsWith("thread.")) return;
        const payload =
          "payload" in event ? (event.payload as Partial<OrchestrationV2AppThread>) : {};
        if (
          payload?.paced != null ||
          payload?.pacedUntil != null ||
          registered.has(event.threadId)
        ) {
          kicked = true;
        }
      }),
    ),
    Effect.forkScoped,
  );

  yield* Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (kicked || nowMs - lastSweep >= SWEEP_EVERY_MS) yield* sweep();
  }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.delay("5 seconds"),
    Effect.forever,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
