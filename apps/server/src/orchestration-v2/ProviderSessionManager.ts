import { AgentScope } from "@t3tools/shared/AgentScope";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import {
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;

const busyTurnPrefix = (providerThreadId: ProviderThreadId) => `${providerThreadId}#`;
/** The identity a turn's start and its `turn.terminal` share. */
const busyTurnKey = (providerThreadId: ProviderThreadId, runOrdinal: number) =>
  `${busyTurnPrefix(providerThreadId)}${runOrdinal}`;
const UNLOAD_THREAD_TIMEOUT_MS = 10 * 1000;

export const ProviderSessionReleaseReason = Schema.Literals([
  "idle_timeout",
  "runtime_error",
  "manual_shutdown",
  "server_shutdown",
]);
export type ProviderSessionReleaseReason = typeof ProviderSessionReleaseReason.Type;

/**
 * ProviderSessionManager owns live session residency: open sessions, idle release,
 * explicit shutdown, and release-on-runtime-failure.
 *
 * It intentionally does not resurrect persisted sessions. Process-loss recovery
 * terminalizes provider-bound work and retires non-replayable effects; a later
 * user command or durable replay-safe operation opens a session lazily.
 */
export class ProviderSessionOpenError extends Schema.TaggedError<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open provider instance ${this.instanceId} session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedError<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to look up provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionCloseError extends Schema.TaggedError<ProviderSessionCloseError>()(
  "ProviderSessionCloseError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionReleaseError extends Schema.TaggedError<ProviderSessionReleaseError>()(
  "ProviderSessionReleaseError",
  {
    providerSessionId: ProviderSessionId,
    reason: ProviderSessionReleaseReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to release provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionActivityError extends Schema.TaggedError<ProviderSessionActivityError>()(
  "ProviderSessionActivityError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to update provider session activity for ${this.providerSessionId}.`;
  }
}

export const ProviderSessionManagerV2Error = Schema.Union([
  ProviderSessionOpenError,
  ProviderWorkspaceMissingError,
  ProviderSessionLookupError,
  ProviderSessionCloseError,
  ProviderSessionReleaseError,
  ProviderSessionActivityError,
]);
export type ProviderSessionManagerV2Error = typeof ProviderSessionManagerV2Error.Type;

export interface ProviderSessionManagerV2Shape {
  readonly shutdown: Effect.Effect<void>;
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly modelSelection: ModelSelection;
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly resumeFromSession?: OrchestrationV2ProviderSession;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ProviderSessionManagerV2Error
  >;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<
    Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>,
    ProviderSessionManagerV2Error
  >;
  readonly close: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  /** Closes every live runtime owned by one provider instance. */
  readonly closeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly release: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly detach: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly detail?: string;
    /**
     * True for terminal detaches (thread archived or deleted): the thread's
     * MCP credentials are revoked immediately instead of surviving for a
     * potential re-attach.
     */
    readonly revokeMcpCredential?: boolean;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

interface LiveSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  /** Native identity survives orchestration adopting an existing app row's id. */
  readonly loadedProviderThreads: ReadonlyMap<string, LoadedProviderThread>;
  /**
   * Process/open credential and latest prepared config for each app thread.
   * Retained for release cleanup even after all its natives unload; native
   * clients retain their own consumed ids in loadedProviderThreads. Revocation on
   * detach/release is scoped to these ids so tearing down a superseded
   * session cannot revoke a replacement session's credential for the same
   * thread (the workspace-handoff sequence opens the replacement before the
   * outbox executes the old session's detach).
   */
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
  readonly supportsMultipleProviderThreads: boolean;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly eventSubscribers: Ref.Ref<
    ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
  >;
  readonly requestEventPermit: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly idleGeneration: number;
  /**
   * Turns this session is running, keyed by `busyTurnKey`. A turn's start adds
   * it and its `turn.terminal` (or a failed start) removes it, so a turn can
   * only clear itself and the session is idle when the set is empty.
   */
  readonly busyTurns: ReadonlySet<string>;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  /** Set when idle release is deferred for pending background work; bounds total deferral. */
  readonly pinnedSinceMs: number | null;
  /**
   * Shared runtimes only: the provider thread each attached app thread last
   * started a turn on, and the timer that unloads it once it has been idle
   * for `idleTimeoutMs`.
   */
  readonly idleThreadUnloads: ReadonlyMap<ThreadId, IdleThreadUnload>;
}

interface LoadedProviderThread {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly key: string | undefined;
  /** The credential actually consumed by this native client. */
  readonly mcpCredentialId: string | undefined;
}

interface IdleThreadUnload {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

type ProviderSessionEventSignal =
  | { readonly type: "event"; readonly event: ProviderAdapter.ProviderAdapterV2Event }
  | {
      readonly type: "failure";
      readonly cause: Cause.Cause<ProviderAdapter.ProviderAdapterV2Error>;
    };

export interface ProviderSessionManagerV2LayerOptions {
  readonly idleTimeoutMs?: number;
  /** Cap on how long idle release may be deferred for pending background work. */
  readonly maxIdlePinMs?: number;
  /** Test replay harnesses can omit T3's MCP server from provider protocol fixtures. */
  readonly configureMcp?: boolean;
}

function releaseStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2ProviderSession["status"] {
  return reason === "runtime_error" ? "error" : "stopped";
}

function releasedRuntimeRequestStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2RuntimeRequest["status"] {
  return reason === "manual_shutdown" || reason === "server_shutdown" ? "cancelled" : "expired";
}

function sessionKey(providerSessionId: ProviderSessionId): string {
  return String(providerSessionId);
}

/**
 * Runtime requests with no provider turn belong to the live session itself.
 * Their node and transcript item are runless too, so they bypass the normal
 * per-run subscriber and are persisted by the session event pump.
 */
function sessionScopedRuntimeRequestThreadId(
  event: ProviderAdapter.ProviderAdapterV2Event,
): ThreadId | undefined {
  switch (event.type) {
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "turn_item.updated":
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}

function providerThreadRuntimeKey(
  providerThread: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"],
): string {
  const nativeThreadRef = providerThread.nativeThreadRef;
  return nativeThreadRef === null
    ? String(providerThread.id)
    : `${nativeThreadRef.driver}:${nativeThreadRef.nativeId}`;
}

function providerThreadLoadKey(input: {
  readonly providerThread: Parameters<
    ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): string {
  return JSON.stringify({
    providerThread: providerThreadRuntimeKey(input.providerThread),
    modelSelection: input.modelSelection ?? null,
    runtimePolicy: input.runtimePolicy ?? null,
  });
}

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  | EventSink.EventSinkV2
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      /**
       * Optional so the many focused tests that assemble this layer by hand do
       * not each need a settings stub; the production composition always
       * provides it. When present, an unreadable settings file withholds
       * browser access rather than granting it — an explicit "off" silently
       * becoming "on" would violate the user's stated choice, whereas the
       * reverse costs an agent one toolset and is visible immediately (#7083).
       */
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const agentScope = yield* AgentScope;
      const agentAccessSettings = Effect.fn("ProviderSessionManagerV2.agentAccessSettings")(
        function* (threadId: ThreadId) {
          if (Option.isNone(serverSettings)) return { browser: true, device: false };
          return yield* Effect.gen(function* () {
            const settings = yield* serverSettings.value.getSettings;
            const thread = yield* projectionStore.getThread(threadId);
            const entries = Object.values(settings.projectSettingsOverrides);
            const browserOverridden = entries.some(
              (entry) => entry.enableAgentBrowserAccess !== undefined,
            );
            const deviceOverridden = entries.some(
              (entry) => entry.enableAgentDeviceAccess !== undefined,
            );
            if (browserOverridden || deviceOverridden) {
              const project = Option.isSome(projectService)
                ? yield* projectService.value.getById(thread.projectId)
                : Option.none();
              if (Option.isNone(project))
                return {
                  browser: browserOverridden ? false : settings.enableAgentBrowserAccess,
                  device: deviceOverridden ? false : settings.enableAgentDeviceAccess,
                };
            }
            const effective = resolveProjectSettings(settings, thread.projectId).settings;
            return {
              browser: effective.enableAgentBrowserAccess,
              device: effective.enableAgentDeviceAccess,
            };
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not resolve agent access; withholding browser and device tools.",
                { threadId, cause },
              ).pipe(Effect.as({ browser: false, device: false })),
            ),
          );
        },
      );
      const layerScope = yield* Effect.scope;
      // Ctrl+C, or a stop that signals the whole process group, reaches the
      // provider CLIs with the server. They report their own background work
      // stopped before shutdown captures restart continuations, so provider
      // events after the signal are dropped; restart recovery owns that state.
      const shutdownSignal = { received: false };
      const onShutdownSignal = () => {
        shutdownSignal.received = true;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGINT", onShutdownSignal);
          process.on("SIGTERM", onShutdownSignal);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGINT", onShutdownSignal);
            process.off("SIGTERM", onShutdownSignal);
          }),
      );
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      // One retry per released entry, so a later release with the same id
      // cannot drop cleanup for threads only the earlier session served.
      const releaseRecordRetries = yield* FiberSet.make();
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* KeyedLock.make<ProviderSessionId>();
      // Orders a thread's attach against a detach unloading it on the same session.
      const threadAttachment = yield* KeyedLock.make<string>();
      const threadAttachmentKey = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) => `${input.providerSessionId}\u0000${input.threadId}`;
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      interface PreparedMcpCredential {
        readonly mcpCredentialId: string | undefined;
        /** True when this call minted the credential (vs reusing a live one). */
        readonly issued: boolean;
      }
      /**
       * Reservations protect a credential between prepareMcpSession handing it
       * out and the owning session entry becoming visible in `sessions`.
       * Adapters like ACP and OpenCode consume the credential eagerly during
       * openSession, so a racing release must not revoke it in that window
       * (rotating afterwards cannot repair an already-configured process).
       * The holder MUST drop the reservation once the entry is recorded or the
       * open fails.
       */
      const mcpCredentialReservations = new Map<string, number>();
      const mcpReservationKey = (threadId: ThreadId, mcpCredentialId: string) =>
        `${threadId}\0${mcpCredentialId}`;
      const reserveMcpCredential = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        mcpCredentialReservations.set(key, (mcpCredentialReservations.get(key) ?? 0) + 1);
      };
      const dropMcpCredentialReservation = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        const count = mcpCredentialReservations.get(key) ?? 0;
        if (count <= 1) {
          mcpCredentialReservations.delete(key);
        } else {
          mcpCredentialReservations.set(key, count - 1);
        }
      };
      const isMcpCredentialReserved = (threadId: ThreadId, mcpCredentialId: string) =>
        (mcpCredentialReservations.get(mcpReservationKey(threadId, mcpCredentialId)) ?? 0) > 0;
      const mcpPrepareLock = yield* KeyedLock.make<ThreadId>();
      const mcpCredentialMatches = (
        resolved: Effect.Success<ReturnType<typeof mcpSessionRegistry.resolve>>,
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
        access: { readonly browser: boolean; readonly device: boolean },
      ) =>
        resolved !== undefined &&
        resolved.thread.threadId === threadId &&
        resolved.thread.providerInstanceId === providerInstanceId &&
        resolved.capabilities.has("preview") === access.browser &&
        resolved.capabilities.has("device") === access.device;

      // Read-only: rejecting a process restart or native reload must
      // leave the current provider's credential intact.
      const mcpAccessNeedsRefresh = (entry: LiveSessionEntry, threadId: ThreadId) =>
        Effect.gen(function* () {
          if (options.configureMcp === false) return false;
          const current = yield* mcpSessions.read(threadId);
          const consumed = entry.mcpCredentialIdByThread.get(threadId);
          if (current === undefined || current.providerSessionId !== consumed) return true;
          const access = yield* agentAccessSettings(threadId);
          const resolved = yield* mcpSessionRegistry.resolve(
            current.authorizationHeader.replace(/^Bearer\s+/, ""),
          );
          return !mcpCredentialMatches(resolved, threadId, entry.runtime.instanceId, access);
        });

      /**
       * Resolves (or mints) the thread's MCP credential and returns it with a
       * reservation held; the caller must drop the reservation exactly once.
       * The caller holds mcpPrepareLock through adapter acceptance and publication,
       * so another provider cannot substitute the config before it is consumed.
       */
      const prepareMcpSession = (
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
        onPrepared: (prepared: PreparedMcpCredential) => void,
        providerSessionId: ProviderSessionId,
        checkAccess?: (
          candidateId: string | undefined,
          willRotate: boolean,
        ) => Effect.Effect<void, ProviderSessionActivityError>,
        providerThread?: OrchestrationV2ProviderThread,
      ): Effect.Effect<PreparedMcpCredential, ProviderSessionActivityError> =>
        options.configureMcp === false
          ? Effect.gen(function* () {
              const prepared = { mcpCredentialId: undefined, issued: false };
              onPrepared(prepared);
              if (checkAccess !== undefined) yield* checkAccess(undefined, false);
              yield* mcpSessions.clear(threadId);
              return prepared;
            })
          : Effect.gen(function* () {
              // Reuse a still-valid credential for this thread instead of
              // rotating: long-lived provider processes (codex app-server)
              // build their MCP client once per conversation and keep using
              // the credential it started with, so a thread that detaches and
              // re-attaches across a workspace handoff must come back to the
              // same token or the process's tool calls fail auth.
              const { browser: browserToolsAvailable, device: deviceToolsAvailable } =
                yield* agentAccessSettings(threadId);
              const capabilities = new Set<import("../mcp/McpInvocationContext.ts").McpCapability>([
                "orchestration",
                "worktree",
                "pull-requests",
              ]);
              if (browserToolsAvailable) capabilities.add("preview");
              if (deviceToolsAvailable) capabilities.add("device");
              const existing = yield* mcpSessions.read(threadId);
              if (existing !== undefined) {
                // Reserve before the async resolve so a release cannot
                // revoke the credential between validation and reservation.
                reserveMcpCredential(threadId, existing.providerSessionId);
                const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
                // The caller only learns of the reservation once this returns,
                // so a failed lookup must drop it here, including on Stop.
                const resolved = yield* mcpSessionRegistry
                  .resolve(rawToken)
                  .pipe(
                    Effect.onError(() =>
                      Effect.sync(() =>
                        dropMcpCredentialReservation(threadId, existing.providerSessionId),
                      ).pipe(
                        Effect.andThen(
                          clearUnownedMcpSession(threadId, existing.providerSessionId),
                        ),
                        Effect.uninterruptible,
                      ),
                    ),
                  );
                if (
                  mcpCredentialMatches(resolved, threadId, providerInstanceId, {
                    browser: browserToolsAvailable,
                    device: deviceToolsAvailable,
                  })
                ) {
                  const prepared = { mcpCredentialId: existing.providerSessionId, issued: false };
                  // The caller owns this reservation before a guard can yield
                  // or fail, including when the last live owner just released it.
                  onPrepared(prepared);
                  if (providerThread !== undefined)
                    yield* checkMcpOwners(threadId, providerSessionId, {
                      nativeThreadKey: providerThreadRuntimeKey(providerThread),
                      candidateId: existing.providerSessionId,
                    });
                  if (checkAccess !== undefined)
                    yield* checkAccess(existing.providerSessionId, false);
                  return prepared;
                }
                yield* Effect.sync(() =>
                  dropMcpCredentialReservation(threadId, existing.providerSessionId),
                );
              }
              // Validate work against this same settings/credential snapshot
              // before any live credential is revoked or issued.
              if (checkAccess !== undefined) yield* checkAccess(existing?.providerSessionId, true);
              yield* checkMcpOwners(threadId, providerSessionId, undefined, providerThread);
              yield* mcpSessionRegistry.revokeThread(threadId);
              return yield* Effect.gen(function* () {
                const credential = yield* mcpSessionRegistry.issue({
                  threadId,
                  providerInstanceId,
                  browserToolsAvailable,
                  capabilities,
                });
                yield* mcpSessions.set(credential.config);
                reserveMcpCredential(threadId, credential.config.providerSessionId);
                const prepared = {
                  mcpCredentialId: credential.config.providerSessionId,
                  issued: true,
                };
                // Publish the cleanup id before restoring interruption: a
                // stop must not leave a minted token outside session records.
                onPrepared(prepared);
                return prepared;
              }).pipe(Effect.uninterruptible);
            });
      /**
       * With a credential id, revocation is scoped to that credential and the
       * config slot is cleared only while it still holds it; a replacement
       * session's newer credential survives. Without one (attach failed before
       * a credential was recorded), fall back to thread-wide revocation.
       */
      const clearMcpSession = (threadId: ThreadId, mcpCredentialId?: string) =>
        mcpCredentialId === undefined
          ? mcpSessionRegistry
              .revokeThread(threadId)
              .pipe(Effect.tap(() => mcpSessions.clear(threadId)))
          : mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if ((yield* mcpSessions.read(threadId))?.providerSessionId === mcpCredentialId) {
                    yield* mcpSessions.clear(threadId);
                  }
                }),
              ),
            );

      const clearUnownedMcpSession = (
        threadId: ThreadId,
        mcpCredentialId: string,
        ignoredRuntime?: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      ) =>
        Ref.get(sessions).pipe(
          Effect.flatMap((current) =>
            isMcpCredentialReserved(threadId, mcpCredentialId) ||
            Array.from(current.values()).some(
              (entry) =>
                entry.runtime !== ignoredRuntime &&
                ownsMcpCredential(entry, threadId, mcpCredentialId),
            )
              ? Effect.void
              : clearMcpSession(threadId, mcpCredentialId),
          ),
        );

      const ownsMcpCredential = (entry: LiveSessionEntry, threadId: ThreadId, id: string) =>
        entry.mcpCredentialIdByThread.get(threadId) === id ||
        Array.from(entry.loadedProviderThreads.values()).some(
          (loaded) => loaded.threadId === threadId && loaded.mcpCredentialId === id,
        );

      // A rotation revokes every credential for the app thread. Inspect every
      // owner, including detached natives and process opens that have no native
      // identity yet. A stale reload uses the same gate for its own client.
      // Probes cannot make unreported native activity atomic with preparation.
      const checkMcpOwners = (
        threadId: ThreadId,
        providerSessionId: ProviderSessionId,
        reload?: { readonly nativeThreadKey: string; readonly candidateId: string },
        providerThread?: OrchestrationV2ProviderThread,
      ) =>
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(sessions);
          const target = snapshot.get(sessionKey(providerSessionId));
          const owners = Array.from(snapshot.values()).flatMap((entry) => {
            const records = Array.from(entry.loadedProviderThreads.values()).filter(
              (loaded) =>
                loaded.threadId === threadId &&
                (reload === undefined ||
                  (entry.runtime.providerSessionId === providerSessionId &&
                    providerThreadRuntimeKey(loaded.providerThread) === reload.nativeThreadKey &&
                    loaded.mcpCredentialId !== reload.candidateId)),
            );
            // An explicit retained native is known even before its first resume
            // in this process. Probe it without inventing a loaded client record.
            if (
              providerThread !== undefined &&
              entry.runtime.providerSessionId === providerSessionId &&
              !entry.loadedProviderThreads.has(providerThreadRuntimeKey(providerThread)) &&
              reload === undefined
            ) {
              records.push({
                threadId,
                providerThread,
                key: undefined,
                mcpCredentialId: entry.mcpCredentialIdByThread.get(threadId),
              });
            }
            // Native-capable sessions retain these ids for release cleanup after
            // unload. Only process-bound clients own them without a loaded native.
            const processOwner =
              reload === undefined &&
              entry.runtime.unloadThread === undefined &&
              entry.mcpCredentialIdByThread.has(threadId);
            return records.length === 0 && !processOwner ? [] : [{ entry, records }];
          });
          if (
            reload === undefined &&
            Array.from(mcpCredentialReservations.keys()).some((key) =>
              key.startsWith(`${threadId}\0`),
            )
          ) {
            return yield* new ProviderSessionActivityError({
              providerSessionId,
              cause: "An in-flight provider configuration prevents refreshing MCP access.",
            });
          }
          for (const { entry, records } of owners) {
            const uncertain =
              entry.runtime.unloadThread === undefined ||
              records.length === 0 ||
              records.some((record) => record.providerThread.nativeThreadRef === null);
            if (
              uncertain
                ? entry.busyTurns.size > 0
                : records.some((record) => hasBusyTurn(entry, record.providerThread.id))
            ) {
              return yield* new ProviderSessionActivityError({
                providerSessionId,
                cause: "An active turn prevents refreshing MCP access.",
              });
            }
            const pending = yield* (
              uncertain || entry.runtime.hasPendingBackgroundWorkForThread === undefined
                ? (entry.runtime.hasPendingBackgroundWork ?? Effect.succeed(false))
                : Effect.forEach(records, (record) =>
                    entry.runtime.hasPendingBackgroundWorkForThread!(record.providerThread),
                  ).pipe(Effect.map((results) => results.some(Boolean)))
            ).pipe(
              Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
              Effect.mapError(
                (cause) => new ProviderSessionActivityError({ providerSessionId, cause }),
              ),
            );
            if (pending) {
              return yield* new ProviderSessionActivityError({
                providerSessionId,
                cause: "Pending background work prevents refreshing MCP access.",
              });
            }
          }
          const latest = yield* Ref.get(sessions);
          if (latest.get(sessionKey(providerSessionId))?.runtime !== target?.runtime) {
            return yield* new ProviderSessionActivityError({
              providerSessionId,
              cause: "The provider session changed while checking pending work.",
            });
          }
          for (const { entry } of owners) {
            const current = latest.get(sessionKey(entry.runtime.providerSessionId));
            if (
              current?.runtime !== entry.runtime ||
              current.loadedProviderThreads !== entry.loadedProviderThreads ||
              current.mcpCredentialIdByThread !== entry.mcpCredentialIdByThread ||
              current.busyTurns !== entry.busyTurns ||
              current.idleGeneration !== entry.idleGeneration ||
              current.lastActivityAtMs !== entry.lastActivityAtMs
            ) {
              return yield* new ProviderSessionActivityError({
                providerSessionId,
                cause: "The provider session changed or became active while checking pending work.",
              });
            }
          }
        });

      const publishToSubscribers = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        signal: ProviderSessionEventSignal,
      ) =>
        Ref.get(subscribers).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.values(), (queue) => Queue.offer(queue, signal), {
              discard: true,
            }),
          ),
        );

      const failSubscribers = (entry: LiveSessionEntry, detail: string) =>
        Effect.gen(function* () {
          const error = new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: entry.runtime.driver,
            providerSessionId: entry.runtime.providerSessionId,
            cause: detail,
          });
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) =>
              Queue.offer(queue, {
                type: "failure",
                cause: Cause.fail(error),
              }),
            { discard: true },
          );
        });

      const closeSubscribers = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) => Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue))),
            { discard: true },
          );
        });

      // Preserve already-published terminal events while ending subscriptions.
      // Server shutdown intentionally clears them; a provider-announced Stop
      // must let consumers drain them before the stream completes.
      const endSubscribers = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(subscribers.values(), (queue) => Queue.end(queue), {
            discard: true,
          });
        });

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);

      const writeProviderSessionEvents = (input: {
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly threadIds: Iterable<ThreadId>;
        readonly type: "provider-session.attached" | "provider-session.updated";
        readonly payload: OrchestrationV2ProviderSession;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Effect.forEach(input.threadIds, (threadId) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId: input.runtime.providerSessionId,
                }),
                type: input.type,
                threadId,
                driver: input.runtime.driver,
                providerInstanceId: input.runtime.instanceId,
                occurredAt: now,
                payload: input.payload,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          if (events.length > 0) {
            yield* eventSink.write({ events });
          }
        });

      const writeReleasedSessionEvents = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const payload: OrchestrationV2ProviderSession = {
            ...input.entry.runtime.providerSession,
            status: releaseStatusFor(input.reason),
            updatedAt: now,
            lastError:
              input.reason === "runtime_error"
                ? (input.detail ?? "Provider runtime failed.")
                : null,
          };
          yield* writeProviderSessionEvents({
            runtime: input.entry.runtime,
            threadIds: input.entry.attachedThreadIds,
            type: "provider-session.updated",
            payload,
          });
        });

      const writeReleasedRuntimeRequestEvents = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        /** Requests created later belong to a replacement session with the same id. */
        readonly releasedAt: DateTime.Utc;
      }) =>
        Effect.gen(function* () {
          const providerSessionId = input.entry.runtime.providerSessionId;
          const now = yield* DateTime.now;
          const status = releasedRuntimeRequestStatusFor(input.reason);
          const reason =
            input.reason === "runtime_error"
              ? "Provider session failed before this runtime request was resolved."
              : "Provider session was closed before this runtime request was resolved.";

          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const threadId of input.entry.attachedThreadIds) {
            const projection = yield* projectionStore.getThreadRecords(
              threadId,
              ["runtimeRequests", "nodes", "turnItems"],
              { turnItemTypes: ["approval_request", "user_input_request"] },
            );
            const releasedRequests = projection.runtimeRequests.filter(
              (request) =>
                request.status === "pending" &&
                request.responseCapability.type === "live" &&
                request.responseCapability.providerSessionId === providerSessionId &&
                DateTime.isLessThanOrEqualTo(request.createdAt, input.releasedAt),
            );

            for (const request of releasedRequests) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "runtime-request.updated",
                threadId,
                nodeId: request.nodeId,
                driver: input.entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...request,
                  status,
                  responseCapability: {
                    type: "not_resumable",
                    reason,
                  },
                  resolvedAt: now,
                },
              });

              const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
              if (requestNode !== undefined) {
                events.push({
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId,
                  }),
                  type: "node.updated",
                  threadId,
                  ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
                  nodeId: requestNode.id,
                  driver: input.entry.runtime.driver,
                  occurredAt: now,
                  payload: {
                    ...requestNode,
                    status: input.reason === "runtime_error" ? "failed" : "cancelled",
                    completedAt: now,
                  },
                });
              }

              const turnItem = projection.turnItems.find(
                (item) =>
                  (item.type === "approval_request" || item.type === "user_input_request") &&
                  item.requestId === request.id,
              );
              if (turnItem !== undefined) {
                events.push({
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId,
                  }),
                  type: "turn-item.updated",
                  threadId,
                  ...(turnItem.runId === null ? {} : { runId: turnItem.runId }),
                  ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
                  driver: input.entry.runtime.driver,
                  occurredAt: now,
                  payload: {
                    ...turnItem,
                    status: input.reason === "runtime_error" ? "failed" : "cancelled",
                    completedAt: now,
                    updatedAt: now,
                  },
                });
              }
            }
          }

          if (events.length > 0) {
            yield* eventSink.write({ events });
          }
        });

      // Reads the background tasks a released session's process left on its
      // provider threads. Read as soon as the session leaves the live map:
      // after that, a replacement session with the same id can open and report
      // tasks of its own on the same provider threads. Server shutdown keeps
      // rosters, since startup recovery clears them and records the cancelled
      // work. Only runtimes whose tasks end with their process opt in (Claude,
      // Muse). OpenCode's background subagents run on a server shared by its
      // sessions and can outlive this one, so their roster stays.
      const readReleasedBackgroundTasks = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detachedThreadId?: ThreadId;
      }) =>
        Effect.gen(function* () {
          if (
            input.reason === "server_shutdown" ||
            input.entry.runtime.backgroundTasksEndWithProcess !== true
          ) {
            return [];
          }
          const providerSessionId = input.entry.runtime.providerSessionId;
          // A detach that released the session already removed its thread
          // from the attached set.
          const threadIds = new Set(input.entry.attachedThreadIds);
          if (input.detachedThreadId !== undefined) threadIds.add(input.detachedThreadId);
          const released = [];
          for (const threadId of threadIds) {
            const projection = yield* projectionStore.getThreadRecords(threadId, [
              "providerThreads",
            ]);
            for (const providerThread of projection.providerThreads) {
              const tasks = providerThread.pendingBackgroundTasks ?? [];
              if (providerThread.providerSessionId !== providerSessionId || tasks.length === 0) {
                continue;
              }
              released.push({
                threadId,
                providerSessionId,
                providerThreadId: providerThread.id,
                taskIds: new Set(tasks.map((task) => task.taskId)),
              });
            }
          }
          return released;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.provider-session-release-roster-read-failed", {
              providerSessionId: input.entry.runtime.providerSessionId,
              cause,
            }).pipe(Effect.as([])),
          ),
        );
      type ReleasedBackgroundTasks = Effect.Success<
        ReturnType<typeof readReleasedBackgroundTasks>
      >[number];

      // Removes the tasks `readReleasedBackgroundTasks` found from their
      // rosters. Their process is gone, so nothing will report them ending,
      // and a leftover roster keeps the thread Waiting (#15239). Tasks a
      // replacement session reported since are left in place. The write
      // commits only if the stored row still equals what was read, and is
      // retried a few times when a provider update lands in between.
      const writeReleasedBackgroundWorkEvents = (
        released: ReadonlyArray<ReleasedBackgroundTasks>,
      ) =>
        Effect.forEach(
          released,
          ({ threadId, providerSessionId, providerThreadId, taskIds }) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt++) {
                const projection = yield* projectionStore.getThreadRecords(threadId, [
                  "providerThreads",
                ]);
                const providerThread = projection.providerThreads.find(
                  (candidate) => candidate.id === providerThreadId,
                );
                const tasks = providerThread?.pendingBackgroundTasks ?? [];
                const remaining = tasks.filter((task) => !taskIds.has(task.taskId));
                if (providerThread === undefined || remaining.length === tasks.length) return;
                const now = yield* DateTime.now;
                const { committed } = yield* eventSink.writeIfProviderThreadUnchanged({
                  expected: providerThread,
                  events: [
                    {
                      id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
                      type: "provider-thread.updated",
                      threadId,
                      driver: providerThread.driver,
                      providerInstanceId: providerThread.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        ...providerThread,
                        pendingBackgroundTasks: remaining,
                        updatedAt: now,
                      },
                    },
                  ],
                });
                if (committed) return;
              }
              yield* Effect.logWarning(
                "orchestration-v2.provider-session-release-roster-conflict",
                {
                  providerSessionId,
                  providerThreadId,
                },
              );
            }),
          { discard: true },
        );

      // Records a released session as stopped and resolves the live runtime
      // requests and background-task rosters it left. Each write runs even if
      // another fails. Once a replacement session opens with the same id, it
      // owns the session status, so only the requests are settled.
      const writeReleaseRecords = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly releasedBackgroundTasks: ReadonlyArray<ReleasedBackgroundTasks>;
        readonly releasedAt: DateTime.Utc;
        readonly replaced: boolean;
      }) =>
        Effect.all(
          [
            input.replaced
              ? Effect.succeed(Exit.void)
              : Effect.exit(writeReleasedSessionEvents(input)),
            Effect.exit(
              writeReleasedRuntimeRequestEvents(input).pipe(
                input.entry.requestEventPermit.withPermits(1),
              ),
            ),
            Effect.exit(writeReleasedBackgroundWorkEvents(input.releasedBackgroundTasks)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.flatMap(Exit.asVoidAll));

      // The session already left the live map, so a later release finds
      // nothing to do. Without a retry the UI would keep a ready session and
      // answerable approvals until a server restart. Each attempt holds the
      // session's open lock, so it sees a replacement that opened meanwhile.
      const retryReleaseRecords = (
        input: Omit<Parameters<typeof writeReleaseRecords>[0], "replaced">,
      ) => {
        const providerSessionId = input.entry.runtime.providerSessionId;
        const attempt = Effect.gen(function* () {
          const exit = yield* Effect.exit(
            sessionOpen.withLock(
              providerSessionId,
              Effect.gen(function* () {
                const replaced = (yield* Ref.get(sessions)).has(sessionKey(providerSessionId));
                yield* writeReleaseRecords({ ...input, replaced });
              }),
            ),
          );
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
          yield* Effect.logWarning("orchestration-v2.provider-session-release-records-failed", {
            providerSessionId,
            cause: exit.cause,
          });
          // A failed SQL commit is a defect, so every failure but interruption
          // is retried.
          return yield* Effect.fail(exit.cause);
        });
        return attempt.pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30))),
              ),
            ),
          }),
          Effect.delay("1 second"),
          FiberSet.run(releaseRecordRetries),
        );
      };

      const logReleaseFailure =
        (providerSessionId: ProviderSessionId) =>
        <E, R>(release: Effect.Effect<void, E, R>) =>
          release.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-failed", {
                providerSessionId,
                cause,
              }),
            ),
          );

      // Removes the live entry and reads the request cleanup cutoff while
      // holding the entry's request permit. A request the event pump is
      // persisting for this runtime lands before the cutoff, and once the
      // entry is gone the pump persists no more for it. A replacement's
      // requests come after its own open.
      const removeLiveEntry = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly onlyIfIdleGeneration?: number;
        readonly requireIdle?: boolean;
      }): Effect.Effect<
        readonly [Option.Option<LiveSessionEntry>, DateTime.Utc],
        ProviderSessionActivityError
      > =>
        Effect.gen(function* () {
          const key = sessionKey(input.providerSessionId);
          const candidate = (yield* Ref.get(sessions)).get(key);
          if (candidate === undefined) {
            return [Option.none<LiveSessionEntry>(), yield* DateTime.now] as const;
          }
          const expectedGeneration =
            input.onlyIfIdleGeneration ??
            (input.requireIdle ? candidate.idleGeneration : undefined);
          if (input.requireIdle) {
            const pending = yield* (
              candidate.runtime.hasPendingBackgroundWork ?? Effect.succeed(false)
            ).pipe(
              Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
              Effect.mapError(
                (cause) =>
                  new ProviderSessionActivityError({
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );
            if (pending) {
              return yield* new ProviderSessionActivityError({
                providerSessionId: input.providerSessionId,
                cause: "Pending background work prevents reopening the provider session.",
              });
            }
          }
          const removed = yield* Effect.zip(
            Ref.modify(sessions, (current) => {
              const existing = current.get(key);
              if (existing !== candidate) {
                return [existing === undefined ? "gone" : "changed", current] as const;
              }
              if (input.requireIdle && existing.busyTurns.size > 0) {
                return ["busy", current] as const;
              }
              if (
                expectedGeneration !== undefined &&
                (existing.busyTurns.size > 0 || existing.idleGeneration !== expectedGeneration)
              ) {
                return ["kept", current] as const;
              }
              const updated = new Map(current);
              updated.delete(key);
              return ["removed", updated] as const;
            }),
            DateTime.now,
          ).pipe(candidate.requestEventPermit.withPermits(1));
          const [outcome, releasedAt] = removed;
          if (
            input.requireIdle &&
            (outcome === "changed" || outcome === "kept" || outcome === "gone")
          ) {
            return yield* new ProviderSessionActivityError({
              providerSessionId: input.providerSessionId,
              cause: "Provider activity changed while checking whether the session can reopen.",
            });
          }
          // Unconditional releases can follow a replacement; idle checks cannot.
          if (outcome === "changed") return yield* removeLiveEntry(input);
          if (outcome === "busy") {
            return yield* new ProviderSessionActivityError({
              providerSessionId: input.providerSessionId,
              cause: "The provider session has an active turn and cannot be reopened.",
            });
          }
          return [
            outcome === "removed" ? Option.some(candidate) : Option.none<LiveSessionEntry>(),
            releasedAt,
          ] as const;
        });

      // Scope close can wedge on a misbehaving adapter finalizer (e.g. a
      // provider process that never yields its message stream). Time-box it so
      // the caller, and any lock or worker it holds, moves on and leaves a
      // diagnosable trail. A close that finishes late is still logged.
      const closeScopeWithin = (
        scope: Scope.Closeable,
        annotations: { readonly providerSessionId?: ProviderSessionId; readonly reason: string },
      ) =>
        Effect.gen(function* () {
          const closeFiber = yield* Scope.close(scope, Exit.void).pipe(
            Effect.exit,
            Effect.forkDetach({ startImmediately: true }),
          );
          const closeExit = yield* Fiber.join(closeFiber).pipe(
            Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
          );
          if (Option.isNone(closeExit)) {
            yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
              ...annotations,
              timeoutMs: RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
            });
            yield* Fiber.join(closeFiber).pipe(
              Effect.flatMap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("orchestration-v2.provider-session-scope-close-failed", {
                      ...annotations,
                      cause: exit.cause,
                    })
                  : Effect.logInfo(
                      "orchestration-v2.provider-session-scope-close-completed-late",
                      annotations,
                    ),
              ),
              Effect.forkDetach,
            );
          }
          return closeExit;
        });

      const releaseEntry = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        /** The thread whose detach released the session; it is no longer attached. */
        readonly detachedThreadId?: ThreadId;
        readonly cancelIdleFiber?: boolean;
        readonly onlyIfIdleGeneration?: number;
        readonly requireIdle?: boolean;
        readonly gracefulSubscribers?: boolean;
      }) =>
        Effect.acquireUseRelease(
          removeLiveEntry(input),
          ([entry, releasedAt]) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                Effect.gen(function* () {
                  const releasedBackgroundTasks = yield* readReleasedBackgroundTasks({
                    entry,
                    reason: input.reason,
                    ...(input.detachedThreadId === undefined
                      ? {}
                      : { detachedThreadId: input.detachedThreadId }),
                  });
                  if (input.cancelIdleFiber !== false) {
                    yield* cancelIdleFiber(entry.idleFiber);
                  }
                  if (input.gracefulSubscribers === true) {
                    yield* endSubscribers(entry);
                  } else if (input.reason === "server_shutdown") {
                    yield* closeSubscribers(entry);
                  } else {
                    yield* failSubscribers(
                      entry,
                      input.detail ?? `Provider session released: ${input.reason}.`,
                    );
                  }
                  const closeExit = yield* closeScopeWithin(entry.scope, {
                    providerSessionId: input.providerSessionId,
                    reason: input.reason,
                  });
                  const records = {
                    entry,
                    reason: input.reason,
                    ...(input.detail === undefined ? {} : { detail: input.detail }),
                    releasedBackgroundTasks,
                    releasedAt,
                  };
                  const recorded = yield* Effect.exit(
                    writeReleaseRecords({ ...records, replaced: false }),
                  );
                  if (Exit.isFailure(recorded)) {
                    yield* retryReleaseRecords(records);
                    return yield* recorded;
                  }
                  if (Option.isSome(closeExit) && Exit.isFailure(closeExit.value)) {
                    return yield* Effect.failCause(closeExit.value.cause);
                  }
                }).pipe(
                  withMetrics({
                    counter: providerSessionsTotal,
                    attributes: {
                      provider: entry.runtime.driver,
                      operation: "release",
                      reason: input.reason,
                    },
                  }),
                ),
            }),
          ([entry]) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                // Revoke every credential this session recorded, including for
                // threads that detached without re-attaching: the provider
                // process is gone, so nothing holds them anymore. Skip threads
                // a live replacement session took over, since credential reuse
                // means the replacement may hold this very credential.
                Ref.get(sessions).pipe(
                  Effect.flatMap((current) =>
                    Effect.forEach(
                      new Map([
                        ...Array.from(
                          entry.mcpCredentialIdByThread,
                          ([threadId, id]) =>
                            [mcpReservationKey(threadId, id), [threadId, id] as const] as const,
                        ),
                        ...Array.from(entry.loadedProviderThreads.values()).flatMap((loaded) =>
                          loaded.mcpCredentialId === undefined
                            ? []
                            : [
                                [
                                  mcpReservationKey(loaded.threadId, loaded.mcpCredentialId),
                                  [loaded.threadId, loaded.mcpCredentialId] as const,
                                ] as const,
                              ],
                        ),
                      ]).values(),
                      ([threadId, mcpCredentialId]) => {
                        // Id-sensitive: a stale record for the same thread but
                        // a DIFFERENT credential (left behind by an old session
                        // the thread rotated away from) must not veto revoking
                        // this session's own credential, or it leaks forever.
                        // A reservation means an in-flight open is configuring
                        // a provider process with this credential right now;
                        // revoking it here would strand that process (eager
                        // adapters cannot pick up a rotated token).
                        const heldElsewhere =
                          isMcpCredentialReserved(threadId, mcpCredentialId) ||
                          Array.from(current.values()).some(
                            (other) =>
                              other !== entry &&
                              ownsMcpCredential(other, threadId, mcpCredentialId),
                          );
                        return heldElsewhere
                          ? Effect.void
                          : clearMcpSession(threadId, mcpCredentialId);
                      },
                      { discard: true },
                    ),
                  ),
                ),
            }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause,
              }),
            ),
          ),
        );

      // Annotated to break the releaseIfStillIdle <-> scheduleIdleReleaseInternal
      // inference cycle introduced by the pin re-arm below.
      const releaseIfStillIdle = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly generation: number;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.busyTurns.size > 0 ||
            entry.idleGeneration !== input.generation
          ) {
            return;
          }
          // Capture runtime identity before yielding: a replacement session
          // can reuse the same providerSessionId while this fiber is parked.
          const probedRuntime = entry.runtime;
          const hasPendingWork =
            probedRuntime.hasPendingBackgroundWork === undefined
              ? false
              : yield* probedRuntime.hasPendingBackgroundWork.pipe(
                  Effect.catchCause(() => Effect.succeed(false)),
                );
          if (hasPendingWork) {
            const now = yield* Clock.currentTimeMillis;
            const pinnedSinceMs = entry.pinnedSinceMs ?? now;
            if (now - pinnedSinceMs < maxIdlePinMs) {
              const shouldContinuePin = yield* Ref.modify(sessions, (latest) => {
                const latestEntry = latest.get(key);
                if (
                  latestEntry === undefined ||
                  latestEntry.busyTurns.size > 0 ||
                  latestEntry.idleGeneration !== input.generation ||
                  latestEntry.runtime !== probedRuntime
                ) {
                  return [false, latest] as const;
                }
                const updated = new Map(latest);
                updated.set(key, { ...latestEntry, pinnedSinceMs });
                return [true, updated] as const;
              });
              if (!shouldContinuePin) {
                // Generation or runtime advanced while we probed pending work;
                // the current owner of the entry owns idle release.
                return;
              }
              yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
                providerSessionId: input.providerSessionId,
                pinnedForMs: now - pinnedSinceMs,
              });
              // Re-check on this fiber after another idle window. Do not call
              // scheduleIdleReleaseInternal: that cancels entry.idleFiber, which
              // is this fiber, and can self-deadlock on Fiber.interrupt.
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              return yield* releaseIfStillIdle(input);
            }
            yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: now - pinnedSinceMs,
            });
          }
          // hasPendingBackgroundWork yields to the adapter, so the idle
          // decision above can go stale; the generation guard revalidates
          // busyTurns and idleGeneration inside releaseEntry's atomic
          // entry removal.
          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
            onlyIfIdleGeneration: input.generation,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.idle-release-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });

      const withActivityError = <A, E, R>(
        providerSessionId: ProviderSessionId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, ProviderSessionActivityError, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionActivityError({
                providerSessionId,
                cause,
              }),
            ),
          ),
        );

      // Provider activity restarts the pin budget, so background work that keeps
      // reporting progress (a long Claude workflow) is never cut off; only work
      // that went silent for maxIdlePinMs is released.
      const scheduleIdleReleaseInternal = (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) =>
        Effect.gen(function* () {
          const key = sessionKey(providerSessionId);
          const current = yield* Ref.get(sessions);
          const entry = current.get(key);
          if (entry === undefined || entry.busyTurns.size > 0) {
            return;
          }

          yield* cancelIdleFiber(entry.idleFiber);
          const generation = entry.idleGeneration + 1;
          const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(releaseIfStillIdle({ providerSessionId, generation })),
            Effect.forkIn(layerScope),
          );
          const lastActivityAtMs = yield* Clock.currentTimeMillis;
          yield* Ref.update(sessions, (latest) => {
            const latestEntry = latest.get(key);
            if (latestEntry === undefined || latestEntry.busyTurns.size > 0) {
              return latest;
            }
            const updated = new Map(latest);
            updated.set(key, {
              ...latestEntry,
              idleGeneration: generation,
              idleFiber,
              lastActivityAtMs,
              ...(options?.providerActivity === true ? { pinnedSinceMs: null } : {}),
            });
            return updated;
          });
        });

      const scheduleIdleRelease = (providerSessionId: ProviderSessionId) =>
        withActivityError(providerSessionId, scheduleIdleReleaseInternal(providerSessionId));

      const touchActivity = (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (entry === undefined) {
                return current;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId, options);
          }),
        );

      /** Missing/replaced runtimes cannot attach or mint credentials. */
      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.runtime !== input.runtime) {
              return [undefined, current] as const;
            }
            if (entry.attachedThreadIds.has(input.threadId)) return [false, current] as const;
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [true, updated] as const;
          }),
        );

      /**
       * Undoes an attach to `runtime`. A replacement session that reopened under
       * the same id since is left alone.
       */
      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.runtime ||
            !entry.attachedThreadIds.has(input.threadId)
          ) {
            return current;
          }
          const attachedThreadIds = new Set(entry.attachedThreadIds);
          attachedThreadIds.delete(input.threadId);
          const updated = new Map(current);
          updated.set(key, {
            ...entry,
            attachedThreadIds,
          });
          return updated;
        });

      const providerThreadLoadStatus = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly providerThreadKey: string | undefined;
      }) =>
        Ref.get(sessions).pipe(
          Effect.map((current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            const loaded = entry?.loadedProviderThreads.get(
              providerThreadRuntimeKey(input.providerThread),
            );
            const staleMcpCredential =
              loaded !== undefined &&
              loaded.mcpCredentialId !== entry?.mcpCredentialIdByThread.get(input.threadId);
            return {
              loaded:
                input.providerThreadKey !== undefined &&
                loaded?.key === input.providerThreadKey &&
                !staleMcpCredential,
              staleMcpCredential,
            };
          }),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly mcpCredentialId: string | undefined;
        readonly providerThreadKey: string | undefined;
      }) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry?.runtime !== input.runtime) {
            return [false, current] as const;
          }
          const loadedProviderThreads = new Map(entry.loadedProviderThreads);
          loadedProviderThreads.set(providerThreadRuntimeKey(input.providerThread), {
            threadId: input.threadId,
            providerThread: input.providerThread,
            key: input.providerThreadKey,
            mcpCredentialId: input.mcpCredentialId,
          });
          const updated = new Map(current);
          updated.set(key, { ...entry, loadedProviderThreads });
          return [true, updated] as const;
        }).pipe(
          Effect.flatMap((recorded) =>
            recorded
              ? Effect.void
              : Effect.fail(
                  new ProviderSessionActivityError({
                    providerSessionId: input.providerSessionId,
                    cause:
                      "The provider session was released or replaced before publishing native MCP access.",
                  }),
                ),
          ),
        );

      const unloadNativeThread = (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
        providerThread: OrchestrationV2ProviderThread,
      ) =>
        Effect.gen(function* () {
          const key = sessionKey(runtime.providerSessionId);
          const nativeKey = providerThreadRuntimeKey(providerThread);
          const unloading = yield* Ref.modify(sessions, (current) => {
            const entry = current.get(key);
            const loaded = entry?.loadedProviderThreads.get(nativeKey);
            if (entry?.runtime !== runtime || loaded === undefined)
              return [undefined, current] as const;
            const loadedProviderThreads = new Map(entry.loadedProviderThreads);
            const unknownLoad = { ...loaded, key: undefined };
            loadedProviderThreads.set(nativeKey, unknownLoad);
            return [
              unknownLoad,
              new Map(current).set(key, { ...entry, loadedProviderThreads }),
            ] as const;
          });
          yield* runtime.unloadThread!({ providerThread });
          // Failure or interruption retains the pointer and consumed credential.
          yield* Ref.update(sessions, (current) => {
            const entry = current.get(key);
            if (
              entry?.runtime !== runtime ||
              entry.loadedProviderThreads.get(nativeKey) !== unloading
            )
              return current;
            const loadedProviderThreads = new Map(entry.loadedProviderThreads);
            loadedProviderThreads.delete(nativeKey);
            return new Map(current).set(key, { ...entry, loadedProviderThreads });
          });
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly checkAccess?: Parameters<typeof prepareMcpSession>[4];
        readonly providerThread?: OrchestrationV2ProviderThread;
      }) =>
        Effect.suspend(() => {
          let attachedTo: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined;
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          // The whole attach, including undoing a failed one, holds the
          // thread's lock: a concurrent attach of the same thread waits, so it
          // never sees an attachment that this call is about to roll back.
          const attach = Effect.gen(function* () {
            const attached = yield* attachThread(input).pipe(
              // Recorded with no gap for an interrupt: cleanup undoes only an
              // attach this call made, never one an earlier open made.
              Effect.tap((attached) =>
                Effect.sync(() => {
                  if (attached) attachedTo = input.runtime;
                }),
              ),
              Effect.uninterruptible,
            );
            if (attached === undefined) {
              return yield* new ProviderSessionActivityError({
                providerSessionId: input.providerSessionId,
                cause: "The provider session was released or replaced before attaching.",
              });
            }
            // A cached runtime may still be attached after another provider
            // rotated this thread's token. Validate it on every use, so its
            // next resume can reload the native MCP client with a live token.
            const prepared = yield* prepareMcpSession(
              input.threadId,
              input.providerInstanceId,
              (prepared) => (preparedForCleanup = prepared),
              input.providerSessionId,
              input.checkAccess,
              input.providerThread,
            );
            const recorded = yield* Ref.modify(sessions, (current) => {
              const key = sessionKey(input.providerSessionId);
              const entry = current.get(key);
              if (entry === undefined || entry.runtime !== input.runtime) {
                return [false, current] as const;
              }
              const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
              if (prepared.mcpCredentialId !== undefined) {
                mcpCredentialIdByThread.set(input.threadId, prepared.mcpCredentialId);
              }
              const updated = new Map(current);
              updated.set(key, { ...entry, mcpCredentialIdByThread });
              // Publish ownership and remove the reservation in one synchronous
              // update, so a racing release cannot leave this token unowned.
              dropReservation();
              return [true, updated] as const;
            });
            if (!recorded) {
              return yield* new ProviderSessionActivityError({
                providerSessionId: input.providerSessionId,
                cause: "The provider session was released or replaced while preparing MCP access.",
              });
            }
            if (attached) {
              const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
              if (entry !== undefined) {
                yield* withActivityError(
                  input.providerSessionId,
                  writeProviderSessionEvents({
                    runtime: entry.runtime,
                    threadIds: [input.threadId],
                    type: "provider-session.attached",
                    payload: entry.runtime.providerSession,
                  }),
                );
              }
            }
            return prepared;
          }).pipe(
            // An interrupted attach is undone too, so the next attach writes
            // the attachment instead of finding the thread already attached.
            Effect.onError(() =>
              (attachedTo === undefined
                ? Effect.void
                : removeThreadAttachment({ ...input, runtime: attachedTo })
              ).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    dropReservation();
                    const id = preparedForCleanup?.mcpCredentialId;
                    return id === undefined
                      ? Effect.void
                      : clearUnownedMcpSession(
                          input.threadId,
                          id,
                          preparedForCleanup?.issued ? attachedTo : undefined,
                        );
                  }),
                ),
              ),
            ),
          );
          return attach.pipe(
            // The entry's own record (written above while the thread is
            // attached) guards the credential from here on; the reservation
            // is only needed until then. Ensuring covers defects/interrupts.
            Effect.ensuring(Effect.sync(dropReservation)),
          );
        });

      const markBusy = (providerSessionId: ProviderSessionId, turnKey: string) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const idleFiber = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return [undefined, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns: new Set(entry.busyTurns).add(turnKey),
                idleFiber: null,
                lastActivityAtMs: now,
                pinnedSinceMs: null,
              });
              return [entry.idleFiber, updated] as const;
            });
            if (idleFiber === undefined) {
              return yield* new ProviderSessionActivityError({
                providerSessionId,
                cause: "The provider session was released before registering the turn.",
              });
            }
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      // Clearing a turn that is not marked busy (one whose failed start already
      // cleared it, or a subagent turn the manager never started) only
      // records activity.
      const markIdle = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
        runOrdinal: number,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return current;
              }
              const busyTurns = new Set(entry.busyTurns);
              busyTurns.delete(busyTurnKey(providerThreadId, runOrdinal));
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns,
                lastActivityAtMs: now,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
            yield* scheduleThreadUnload(providerSessionId, providerThreadId);
          }),
        );

      const hasBusyTurn = (entry: LiveSessionEntry, providerThreadId: ProviderThreadId) => {
        const prefix = busyTurnPrefix(providerThreadId);
        for (const turnKey of entry.busyTurns) {
          if (turnKey.startsWith(prefix)) return true;
        }
        return false;
      };

      const updateIdleThreadUnload = (
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        update: (current: IdleThreadUnload | undefined) => IdleThreadUnload | undefined,
      ) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) return [undefined, current] as const;
          const previous = entry.idleThreadUnloads.get(threadId);
          const next = update(previous);
          const idleThreadUnloads = new Map(entry.idleThreadUnloads);
          if (next === undefined) idleThreadUnloads.delete(threadId);
          else idleThreadUnloads.set(threadId, next);
          const updated = new Map(current);
          updated.set(key, { ...entry, idleThreadUnloads });
          return [previous, updated] as const;
        });

      /**
       * Starts tracking the provider thread an app thread runs its turns on, and
       * stops any unload pending for it. Called before the thread is resumed or
       * given a turn, so an unload cannot land between a resume that found the
       * thread loaded and the turn that relies on it.
       */
      const holdThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      }) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
          if (
            entry === undefined ||
            !entry.supportsMultipleProviderThreads ||
            entry.exposedRuntime.unloadThread === undefined ||
            input.providerThread.nativeThreadRef === null
          ) {
            return;
          }
          const previous = yield* updateIdleThreadUnload(
            input.providerSessionId,
            input.threadId,
            (current) => ({
              providerThread: input.providerThread,
              generation: (current?.generation ?? 0) + 1,
              fiber: null,
            }),
          );
          yield* cancelIdleFiber(previous?.fiber ?? null);
        });

      /**
       * A shared runtime never goes idle while any of its threads is in use, so
       * its threads get the idle timeout one by one: a thread with no turn for
       * `idleTimeoutMs` is unloaded from the runtime, along with the native MCP
       * servers it started. Its next turn's resume loads it again.
       */
      const scheduleThreadUnload = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
      ) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
          if (entry === undefined || hasBusyTurn(entry, providerThreadId)) return;
          const tracked = Array.from(entry.idleThreadUnloads).find(
            ([, pending]) => pending.providerThread.id === providerThreadId,
          );
          if (tracked === undefined) return;
          const [threadId, pending] = tracked;
          const generation = pending.generation + 1;
          const fiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(unloadIdleThread({ providerSessionId, threadId, generation })),
            Effect.forkIn(layerScope),
          );
          // A turn that started meanwhile already moved the generation on.
          const previous = yield* updateIdleThreadUnload(providerSessionId, threadId, (current) =>
            current?.generation === pending.generation
              ? { ...current, generation, fiber }
              : current,
          );
          yield* cancelIdleFiber(
            previous?.generation === pending.generation ? previous.fiber : fiber,
          );
        });

      const unloadIdleThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly generation: number;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const outcome = yield* threadAttachment.withLock(
            threadAttachmentKey(input),
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              const entry = (yield* Ref.get(sessions)).get(key);
              const pending = entry?.idleThreadUnloads.get(input.threadId);
              const unloadThread = entry?.exposedRuntime.unloadThread;
              if (
                entry === undefined ||
                pending === undefined ||
                pending.generation !== input.generation ||
                unloadThread === undefined ||
                !entry.attachedThreadIds.has(input.threadId) ||
                hasBusyTurn(entry, pending.providerThread.id)
              ) {
                return "skipped" as const;
              }
              // Unloading stops the native thread's background terminals, so a
              // thread still running background work stays loaded.
              const hasPendingWork =
                entry.runtime.hasPendingBackgroundWorkForThread === undefined
                  ? false
                  : yield* entry.runtime
                      .hasPendingBackgroundWorkForThread(pending.providerThread)
                      .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) return "deferred" as const;
              const retainedUnload = { ...pending, fiber: null };
              const unloading = yield* Ref.modify(sessions, (current) => {
                const latest = current.get(key);
                if (
                  latest?.runtime !== entry.runtime ||
                  latest.idleThreadUnloads.get(input.threadId)?.generation !== input.generation
                ) {
                  return [false, current] as const;
                }
                const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                idleThreadUnloads.set(input.threadId, retainedUnload);
                const updated = new Map(current);
                updated.set(key, {
                  ...latest,
                  idleThreadUnloads,
                });
                return [true, updated] as const;
              });
              if (!unloading) return "skipped" as const;
              const unloaded = yield* unloadThread({ providerThread: pending.providerThread }).pipe(
                Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning("orchestration-v2.driver-session.idle-unload-failed", {
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerThreadId: pending.providerThread.id,
                    cause,
                  }).pipe(Effect.as(false)),
                ),
              );
              if (unloaded) {
                yield* Ref.update(sessions, (current) => {
                  const latest = current.get(key);
                  if (
                    latest?.runtime !== entry.runtime ||
                    latest.idleThreadUnloads.get(input.threadId) !== retainedUnload
                  ) {
                    return current;
                  }
                  const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                  idleThreadUnloads.delete(input.threadId);
                  const updated = new Map(current);
                  updated.set(key, {
                    ...latest,
                    idleThreadUnloads,
                  });
                  return updated;
                });
              }
              return unloaded ? ("unloaded" as const) : ("failed" as const);
            }),
          );
          // Re-check on this fiber after another idle window, outside the
          // lock so the thread's next attach is not held up meanwhile.
          if (outcome === "deferred") {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            return yield* unloadIdleThread(input);
          }
        });

      const observeActivity = (
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<void, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
        );

      const makeEventSubscription = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): Effect.Effect<ProviderAdapter.ProviderAdapterV2EventSubscription> =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderSessionEventSignal, Cause.Done>();
          const subscriberId = yield* Ref.getAndUpdate(nextSubscriberId, (value) => value + 1);
          yield* Ref.update(subscribers, (current) => {
            const updated = new Map(current);
            updated.set(subscriberId, queue);
            return updated;
          });
          const close = Ref.modify(subscribers, (current) => {
            if (!current.has(subscriberId)) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.delete(subscriberId);
            return [true, updated] as const;
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
                : Effect.void,
            ),
          );
          const events = Stream.fromQueue(queue).pipe(
            Stream.mapEffect((signal) =>
              signal.type === "event"
                ? Effect.succeed(signal.event)
                : Effect.failCause(signal.cause),
            ),
            Stream.ensuring(close),
          );
          return { events, close } satisfies ProviderAdapter.ProviderAdapterV2EventSubscription;
        });

      const decorateRuntime = (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(eventSubscribers);
        // Every provider's turn operations pass through here, so this is where they are
        // counted. Only turn starts are timed: until the provider accepts the turn.
        const turnMetrics = (operation: string, model?: string) =>
          withMetrics({
            counter: providerTurnsTotal,
            ...(operation === "send" ? { timer: providerTurnDuration } : {}),
            attributes: {
              provider: runtime.driver,
              operation,
              modelFamily: normalizeModelMetricLabel(model),
            },
          });
        const withRuntimeThread = <A, E>(
          threadId: ThreadId,
          providerThread: OrchestrationV2ProviderThread | undefined,
          use: (prepared: PreparedMcpCredential) => Effect.Effect<A, E>,
        ) =>
          threadAttachment.withLock(
            threadAttachmentKey({ providerSessionId, threadId }),
            mcpPrepareLock.withLock(
              threadId,
              // Adapters must consume the config before returning acceptance.
              ensureThreadAttached({
                providerSessionId,
                threadId,
                providerInstanceId: runtime.instanceId,
                runtime,
                ...(providerThread === undefined ? {} : { providerThread }),
                checkAccess: (candidateId, willRotate) =>
                  Effect.gen(function* () {
                    const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
                    if (entry?.runtime !== runtime) {
                      return yield* new ProviderSessionActivityError({
                        providerSessionId,
                        cause:
                          "The provider session was released or replaced before preparing MCP access.",
                      });
                    }
                    if (
                      runtime.unloadThread === undefined &&
                      (willRotate || candidateId !== entry.mcpCredentialIdByThread.get(threadId))
                    ) {
                      return yield* new ProviderSessionActivityError({
                        providerSessionId,
                        cause: "MCP access changed; reopen the provider session before continuing.",
                      });
                    }
                  }),
              }).pipe(Effect.flatMap(use)),
            ),
          );
        const resumeNativeThread = (
          input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]>[0] & {
            readonly threadId: ThreadId;
          },
          staleMcpCredential: boolean,
          mcpCredentialId: string | undefined,
        ) => {
          // Codex keeps its MCP clients in a loaded native conversation.
          // A resume alone retains the revoked token; unload only this
          // conversation before resuming it with the refreshed config.
          const unload = staleMcpCredential
            ? unloadNativeThread(runtime, input.providerThread).pipe(
                Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: runtime.driver,
                      providerSessionId,
                      providerThreadId: input.providerThread.id,
                      cause,
                    }),
                ),
              )
            : Effect.void;
          return unload.pipe(
            // Resume may consume the config before its interruptible wait returns.
            // Retain that ownership even when acceptance is never published.
            Effect.andThen(
              markProviderThreadLoaded({
                runtime,
                providerSessionId,
                threadId: input.threadId,
                providerThread: input.providerThread,
                mcpCredentialId,
                providerThreadKey: undefined,
              }),
            ),
            Effect.andThen(runtime.resumeThread(input)),
          );
        };
        return {
          ...runtime,
          subscribeEvents,
          ...(runtime.unloadThread === undefined
            ? {}
            : {
                unloadThread: ({ providerThread }) => unloadNativeThread(runtime, providerThread),
              }),
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            withRuntimeThread(input.threadId, undefined, (prepared) =>
              runtime.ensureThread(input).pipe(
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    runtime,
                    providerThread,
                    mcpCredentialId: prepared.mcpCredentialId,
                    providerSessionId,
                    threadId: input.threadId,
                    providerThreadKey: providerThreadLoadKey({
                      providerThread,
                      modelSelection: input.modelSelection,
                      runtimePolicy: input.runtimePolicy,
                    }),
                  }),
                ),
              ),
            ).pipe(
              Effect.catchTags({
                ProviderSessionActivityError: (cause) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver: runtime.driver,
                      threadId: input.threadId,
                      cause,
                    }),
                  ),
              }),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              return runtime.resumeThread(input);
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return withRuntimeThread(threadId, input.providerThread, (prepared) =>
              holdThreadLoaded({
                providerSessionId,
                threadId,
                providerThread: input.providerThread,
              }).pipe(
                Effect.andThen(
                  providerThreadLoadStatus({
                    providerSessionId,
                    threadId,
                    providerThread: input.providerThread,
                    providerThreadKey,
                  }),
                ),
                Effect.flatMap(({ loaded, staleMcpCredential }) => {
                  if (loaded) return Effect.succeed(input.providerThread);
                  return resumeNativeThread(
                    { ...input, threadId },
                    staleMcpCredential,
                    prepared.mcpCredentialId,
                  );
                }),
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    runtime,
                    providerThread,
                    mcpCredentialId: prepared.mcpCredentialId,
                    providerSessionId,
                    threadId,
                    providerThreadKey: providerThreadLoadKey({
                      providerThread,
                      ...(input.modelSelection === undefined
                        ? {}
                        : { modelSelection: input.modelSelection }),
                      ...(input.runtimePolicy === undefined
                        ? {}
                        : { runtimePolicy: input.runtimePolicy }),
                    }),
                  }),
                ),
              ),
            ).pipe(
              Effect.catchTags({
                ProviderSessionActivityError: (cause) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: runtime.driver,
                      providerSessionId,
                      providerThreadId: input.providerThread.id,
                      cause,
                    }),
                  ),
              }),
            );
          },
          rollbackThread: (input) => {
            const threadId = input.providerThread.appThreadId;
            if (threadId === null) return runtime.rollbackThread(input);
            return withRuntimeThread(threadId, input.providerThread, (prepared) =>
              Effect.gen(function* () {
                yield* holdThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThread: input.providerThread,
                });
                const cachedKey = (yield* Ref.get(sessions))
                  .get(sessionKey(providerSessionId))
                  ?.loadedProviderThreads.get(providerThreadRuntimeKey(input.providerThread))?.key;
                const { loaded, staleMcpCredential } = yield* providerThreadLoadStatus({
                  providerSessionId,
                  threadId,
                  providerThread: input.providerThread,
                  providerThreadKey: cachedKey,
                });
                const providerThread = loaded
                  ? input.providerThread
                  : yield* resumeNativeThread(
                      { providerThread: input.providerThread, threadId },
                      staleMcpCredential,
                      prepared.mcpCredentialId,
                    );
                // Rollback has no selection/policy; a default resume establishes
                // credential ownership without validating the next turn's load key.
                const providerThreadKey = loaded ? cachedKey : undefined;
                yield* markProviderThreadLoaded({
                  runtime,
                  providerSessionId,
                  threadId,
                  providerThread,
                  mcpCredentialId: prepared.mcpCredentialId,
                  providerThreadKey,
                });
                const snapshot = yield* runtime.rollbackThread({ ...input, providerThread });
                yield* markProviderThreadLoaded({
                  runtime,
                  providerSessionId,
                  threadId,
                  providerThread: snapshot.providerThread,
                  mcpCredentialId: prepared.mcpCredentialId,
                  providerThreadKey:
                    providerThreadRuntimeKey(snapshot.providerThread) ===
                    providerThreadRuntimeKey(providerThread)
                      ? providerThreadKey
                      : undefined,
                });
                return snapshot;
              }),
            ).pipe(
              Effect.catchTags({
                ProviderSessionActivityError: (cause) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterRollbackThreadError({
                      driver: runtime.driver,
                      providerThreadId: input.providerThread.id,
                      cause,
                    }),
                  ),
              }),
            );
          },
          forkThread: (input) =>
            withRuntimeThread(input.targetThreadId, undefined, (prepared) =>
              runtime.forkThread(input).pipe(
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    runtime,
                    providerThread,
                    mcpCredentialId: prepared.mcpCredentialId,
                    providerSessionId,
                    threadId: input.targetThreadId,
                    providerThreadKey: providerThreadLoadKey({
                      providerThread,
                      ...(input.modelSelection === undefined
                        ? {}
                        : { modelSelection: input.modelSelection }),
                      ...(input.runtimePolicy === undefined
                        ? {}
                        : { runtimePolicy: input.runtimePolicy }),
                    }),
                  }),
                ),
              ),
            ).pipe(
              Effect.catchTags({
                ProviderSessionActivityError: (cause) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver: runtime.driver,
                      providerThreadId: input.sourceProviderThread.id,
                      cause,
                    }),
                  ),
              }),
            ),
          startTurn: (input) =>
            withRuntimeThread(input.threadId, input.providerThread, (prepared) =>
              Effect.gen(function* () {
                yield* holdThreadLoaded({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThread: input.providerThread,
                });
                const { loaded, staleMcpCredential } = yield* providerThreadLoadStatus({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThread: input.providerThread,
                  providerThreadKey: providerThreadLoadKey(input),
                });
                // Retained continuations can start without the usual resume.
                const providerThread = !loaded
                  ? yield* resumeNativeThread(
                      {
                        providerThread: input.providerThread,
                        threadId: input.threadId,
                        modelSelection: input.modelSelection,
                        runtimePolicy: input.runtimePolicy,
                      },
                      staleMcpCredential,
                      prepared.mcpCredentialId,
                    )
                  : input.providerThread;
                yield* markProviderThreadLoaded({
                  runtime,
                  providerSessionId,
                  threadId: input.threadId,
                  providerThread,
                  mcpCredentialId: prepared.mcpCredentialId,
                  providerThreadKey: providerThreadLoadKey({ ...input, providerThread }),
                });
                // A failed/stopped start may never emit a terminal event. It
                // clears only its own registration, while accepted turns stay busy.
                return yield* Effect.acquireUseRelease(
                  markBusy(providerSessionId, busyTurnKey(providerThread.id, input.runOrdinal)),
                  () =>
                    runtime
                      .startTurn({ ...input, providerThread })
                      .pipe(turnMetrics("send", input.modelSelection.model)),
                  (_, exit) =>
                    Exit.isFailure(exit)
                      ? observeActivity(
                          providerSessionId,
                          markIdle(providerSessionId, providerThread.id, input.runOrdinal),
                        )
                      : Effect.void,
                );
              }),
            ).pipe(
              Effect.catchTags({
                ProviderSessionActivityError: (cause) =>
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterTurnStartError({
                      driver: runtime.driver,
                      threadId: input.threadId,
                      providerThreadId: input.providerThread.id,
                      runId: input.runId,
                      cause,
                    }),
                  ),
              }),
            ),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.steerTurn(input).pipe(turnMetrics("steer"))),
            ),
          interruptTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.interruptTurn(input).pipe(turnMetrics("interrupt"))),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime
                  .respondToRuntimeRequest(input)
                  .pipe(turnMetrics("runtime-request-response")),
              ),
            ),
        };
      };

      const persistProviderSessionUpdate = (
        entry: LiveSessionEntry,
        event: Extract<
          ProviderAdapter.ProviderAdapterV2Event,
          { readonly type: "provider_session.updated" }
        >,
      ) =>
        Effect.gen(function* () {
          const current = (yield* Ref.get(sessions)).get(
            sessionKey(entry.runtime.providerSessionId),
          );
          if (current?.runtime !== entry.runtime) {
            return;
          }
          yield* writeProviderSessionEvents({
            runtime: entry.runtime,
            threadIds: current.attachedThreadIds,
            type: "provider-session.updated",
            payload: event.providerSession,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
              providerSessionId: entry.runtime.providerSessionId,
              cause,
            }),
          ),
        );

      const startEventPump = (entry: LiveSessionEntry) => {
        let stoppedByProvider = false;
        return entry.runtime.events.pipe(
          Stream.runForEach((event) => {
            if (shutdownSignal.received) return Effect.void;
            if (
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped"
            ) {
              stoppedByProvider = true;
            }
            return observeActivity(
              entry.runtime.providerSessionId,
              event.type === "turn.terminal"
                ? markIdle(
                    entry.runtime.providerSessionId,
                    event.providerThreadId,
                    event.runOrdinal,
                  )
                : touchActivity(entry.runtime.providerSessionId, { providerActivity: true }),
            ).pipe(
              Effect.andThen(
                event.type === "provider_session.updated"
                  ? persistProviderSessionUpdate(entry, event)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  // Some providers can block before a run subscriber exists
                  // (project trust, login, or session-switch hooks). Persist
                  // their runless request artifacts directly so the normal T3
                  // request UI can answer them and unblock session setup.
                  const threadId = sessionScopedRuntimeRequestThreadId(event);
                  if (threadId !== undefined) {
                    yield* Effect.gen(function* () {
                      const current = (yield* Ref.get(sessions)).get(
                        sessionKey(entry.runtime.providerSessionId),
                      );
                      if (current?.runtime !== entry.runtime) return;
                      yield* providerEventIngestor
                        .ingestNormalized({
                          providerSessionId: entry.runtime.providerSessionId,
                          providerInstanceId: entry.runtime.instanceId,
                          threadId,
                          event,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapter.ProviderAdapterEventStreamError({
                                driver: entry.runtime.driver,
                                providerSessionId: entry.runtime.providerSessionId,
                                cause,
                              }),
                          ),
                        );
                    }).pipe(entry.requestEventPermit.withPermits(1));
                    return;
                  }
                  yield* publishToSubscribers(entry.eventSubscribers, { type: "event", event });
                }),
              ),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              // A provider that exits on the shutdown signal is released by shutdown.
              if (shutdownSignal.received) return;
              const current = (yield* Ref.get(sessions)).get(
                sessionKey(entry.runtime.providerSessionId),
              );
              if (current?.runtime !== entry.runtime) {
                return;
              }
              if (stoppedByProvider && Exit.isSuccess(exit)) {
                yield* releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  gracefulSubscribers: true,
                }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
                return;
              }
              const cause = Exit.isFailure(exit)
                ? exit.cause
                : Cause.fail(
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver: entry.runtime.driver,
                      providerSessionId: entry.runtime.providerSessionId,
                      cause: "Provider event stream ended unexpectedly.",
                    }),
                  );
              yield* publishToSubscribers(entry.eventSubscribers, {
                type: "failure",
                cause,
              });
              yield* Ref.set(entry.eventSubscribers, new Map());
              yield* releaseEntry({
                providerSessionId: entry.runtime.providerSessionId,
                reason: "runtime_error",
                detail: Cause.pretty(cause),
              }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
            }),
          ),
          Effect.forkIn(layerScope),
        );
      };

      // Parent of every session scope. On layer close, shutdown releases the
      // live sessions first, then closes any session whose open is still in
      // flight, time-boxed so a stuck adapter cannot hold up server shutdown.
      // Both steps run in parallel. The service launcher kills the server
      // 5 s after it asks it to stop, and a busy server can hold 15 sessions.
      const sessionScopes = yield* Scope.make("parallel");
      const shutdown = Effect.gen(function* () {
        const activeSessions = [...(yield* Ref.get(sessions)).values()];
        yield* Effect.forEach(
          activeSessions,
          (entry) =>
            releaseEntry({
              providerSessionId: entry.runtime.providerSessionId,
              reason: "server_shutdown",
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                  providerSessionId: entry.runtime.providerSessionId,
                  cause,
                }),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        );
      });
      yield* Effect.addFinalizer(() =>
        shutdown.pipe(
          Effect.ensuring(closeScopeWithin(sessionScopes, { reason: "server_shutdown" })),
        ),
      );

      return ProviderSessionManagerV2.of({
        shutdown,
        open: (input) =>
          Effect.suspend(() => {
            let preparedForCleanup: PreparedMcpCredential | undefined;
            let openingScope: Scope.Closeable | undefined;
            let reservationDropped = false;
            const dropReservation = Effect.sync(() => {
              const id = preparedForCleanup?.mcpCredentialId;
              if (!reservationDropped && id !== undefined) {
                reservationDropped = true;
                dropMcpCredentialReservation(input.threadId, id);
              }
            });
            // Any failure, including a Stop that interrupts a slow handshake,
            // stops the provider process this open started. The close is
            // time-boxed: this runs under the session's open lock, so a wedged
            // adapter finalizer must not hold the interrupter or later opens.
            const cleanupOpen = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
              Ref.get(sessions).pipe(
                Effect.flatMap((current) => {
                  const scope = openingScope;
                  if (
                    scope !== undefined &&
                    current.get(sessionKey(input.providerSessionId))?.scope === scope
                  ) {
                    // The open lock prevents another open replacing this entry
                    // while failure cleanup hands it to the normal lifecycle.
                    return releaseEntry({
                      providerSessionId: input.providerSessionId,
                      reason: Cause.hasInterruptsOnly(cause) ? "manual_shutdown" : "runtime_error",
                      detail: Cause.hasInterruptsOnly(cause)
                        ? "The provider session start was interrupted."
                        : "The provider session did not finish opening.",
                    }).pipe(logReleaseFailure(input.providerSessionId));
                  }
                  return scope === undefined
                    ? Effect.void
                    : closeScopeWithin(scope, {
                        providerSessionId: input.providerSessionId,
                        reason: "open_failed",
                      });
                }),
              );
            return sessionOpen.withLock(
              input.providerSessionId,
              Effect.gen(function* () {
                const cwd = input.runtimePolicy.cwd;
                if (cwd !== null) {
                  const workspaceIsDirectory = yield* fileSystem.stat(cwd).pipe(
                    Effect.map((stat) => stat.type === "Directory"),
                    Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
                  );
                  if (!workspaceIsDirectory) {
                    return yield* new ProviderWorkspaceMissingError({
                      threadId: input.threadId,
                      cwd,
                    });
                  }
                }
                const key = sessionKey(input.providerSessionId);
                const existing = (yield* Ref.get(sessions)).get(key);
                if (existing !== undefined) {
                  const attached = existing.attachedThreadIds.has(input.threadId);
                  if (!attached && !existing.supportsMultipleProviderThreads) {
                    return yield* new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause: `Provider ${existing.runtime.driver} does not support attaching multiple app threads to one session.`,
                    });
                  }
                  if (
                    attached &&
                    existing.runtime.unloadThread === undefined &&
                    (yield* mcpAccessNeedsRefresh(existing, input.threadId))
                  ) {
                    // Pi and other process-bound MCP clients can only pick up
                    // changed access by reopening through the normal lifecycle.
                    yield* releaseEntry({
                      providerSessionId: input.providerSessionId,
                      reason: "manual_shutdown",
                      requireIdle: true,
                    }).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderSessionOpenError({
                            instanceId: input.modelSelection.instanceId,
                            providerSessionId: input.providerSessionId,
                            cause,
                          }),
                      ),
                    );
                  } else {
                    // Joining a shared session is a new session for this thread.
                    if (!attached) yield* agentScope.clear(input.threadId);
                    // Cached native clients prepare access at the operation
                    // boundary, where pending work can reject a reload safely.
                    if (
                      !attached &&
                      (existing.runtime.unloadThread === undefined ||
                        !Array.from(existing.loadedProviderThreads.values()).some(
                          (loaded) => loaded.threadId === input.threadId,
                        ))
                    )
                      yield* threadAttachment.withLock(
                        threadAttachmentKey(input),
                        mcpPrepareLock.withLock(
                          input.threadId,
                          ensureThreadAttached({
                            providerSessionId: input.providerSessionId,
                            threadId: input.threadId,
                            providerInstanceId: existing.runtime.instanceId,
                            runtime: existing.runtime,
                          }),
                        ),
                      );
                    yield* touchActivity(input.providerSessionId);
                    return existing.exposedRuntime;
                  }
                }

                return yield* mcpPrepareLock.withLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const adapter = yield* registry.get(input.modelSelection.instanceId).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderSessionOpenError({
                            instanceId: input.modelSelection.instanceId,
                            providerSessionId: input.providerSessionId,
                            cause,
                          }),
                      ),
                    );
                    const prepared = yield* prepareMcpSession(
                      input.threadId,
                      input.modelSelection.instanceId,
                      (prepared) => (preparedForCleanup = prepared),
                      input.providerSessionId,
                    );
                    const mcpCredentialId = prepared.mcpCredentialId;
                    // The reservation from prepare protects the credential (which
                    // eager adapters bake into the provider process during
                    // openSession) from racing releases until this session's entry
                    // is recorded below. Dropped exactly once on every path.
                    const sessionScope = yield* Scope.fork(sessionScopes).pipe(
                      Effect.tap((scope) => Effect.sync(() => (openingScope = scope))),
                      Effect.uninterruptible,
                    );
                    // The previous session's agent scope must not explain this
                    // session's failures, even when this provider runs without one.
                    yield* agentScope.clear(input.threadId);
                    const runtime = yield* adapter
                      .openSession({
                        threadId: input.threadId,
                        providerSessionId: input.providerSessionId,
                        modelSelection: input.modelSelection,
                        runtimePolicy: input.runtimePolicy,
                        ...(input.resumeFromSession === undefined
                          ? {}
                          : { resumeFromSession: input.resumeFromSession }),
                        ...(input.initialNativeThreadId === undefined
                          ? {}
                          : { initialNativeThreadId: input.initialNativeThreadId }),
                        ...(input.initialProviderItemIdentityVersion === undefined
                          ? {}
                          : {
                              initialProviderItemIdentityVersion:
                                input.initialProviderItemIdentityVersion,
                            }),
                      })
                      .pipe(
                        Effect.provideService(Scope.Scope, sessionScope),
                        Effect.mapError(
                          (cause) =>
                            new ProviderSessionOpenError({
                              instanceId: input.modelSelection.instanceId,
                              providerSessionId: input.providerSessionId,
                              cause,
                            }),
                        ),
                        withMetrics({
                          counter: providerSessionsTotal,
                          attributes: { provider: adapter.driver, operation: "open" },
                        }),
                      );
                    const eventSubscribers = yield* Ref.make<
                      ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
                    >(new Map());
                    const exposedRuntime = decorateRuntime(runtime, eventSubscribers);
                    const now = yield* Clock.currentTimeMillis;
                    const entry: LiveSessionEntry = {
                      attachedThreadIds: new Set([input.threadId]),
                      // Process-bound adapters consume MCP access during open, before
                      // the first native thread is loaded. Keep that credential until
                      // a successful native reload records its replacement.
                      loadedProviderThreads: new Map(),
                      mcpCredentialIdByThread:
                        mcpCredentialId === undefined
                          ? new Map()
                          : new Map([[input.threadId, mcpCredentialId]]),
                      supportsMultipleProviderThreads:
                        runtime.providerSession.capabilities.sessions
                          .supportsMultipleProviderThreadsPerSession,
                      runtime,
                      exposedRuntime,
                      eventSubscribers,
                      requestEventPermit: yield* Semaphore.make(1),
                      scope: sessionScope,
                      idleGeneration: 0,
                      busyTurns: new Set(),
                      lastActivityAtMs: now,
                      idleFiber: null,
                      pinnedSinceMs: null,
                      idleThreadUnloads: new Map(),
                    };
                    yield* Ref.update(sessions, (current) => {
                      const updated = new Map(current);
                      updated.set(key, entry);
                      return updated;
                    });
                    // The entry now guards the credential via its recorded id, so
                    // the pre-open reservation can be dropped.
                    yield* dropReservation;
                    yield* withActivityError(
                      input.providerSessionId,
                      writeProviderSessionEvents({
                        runtime,
                        threadIds: [input.threadId],
                        type: "provider-session.attached",
                        payload: runtime.providerSession,
                      }),
                    );
                    yield* startEventPump(entry);
                    yield* scheduleIdleRelease(input.providerSessionId);
                    return exposedRuntime;
                  }).pipe(
                    // A waiter must see cleanup finished before preparing its config.
                    // Scope close stays outside this gate so provider finalizers cannot
                    // hold up another provider's open.
                    Effect.onError(() =>
                      Effect.gen(function* () {
                        yield* dropReservation;
                        const id = preparedForCleanup?.mcpCredentialId;
                        if (id !== undefined) yield* clearUnownedMcpSession(input.threadId, id);
                      }),
                    ),
                  ),
                );
              }).pipe(Effect.onError((cause) => cleanupOpen(cause))),
            );
          }),
        get: (providerSessionId) =>
          Effect.gen(function* () {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined) {
              return Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId);
            return Option.some(entry.exposedRuntime);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionLookupError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        close: (providerSessionId) =>
          releaseEntry({ providerSessionId, reason: "manual_shutdown" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        closeInstance: (instanceId) =>
          Effect.gen(function* () {
            const active = [...(yield* Ref.get(sessions)).values()].filter(
              (entry) => entry.runtime.instanceId === instanceId,
            );
            const outcomes = yield* Effect.forEach(
              active,
              (entry) =>
                releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  detail: `Provider instance ${instanceId} logged out.`,
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            const failure = outcomes.find(Exit.isFailure);
            if (failure !== undefined && Exit.isFailure(failure)) {
              return yield* Effect.failCause(failure.cause);
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId: ProviderSessionId.make(
                    `provider-session:provider-instance:${instanceId}`,
                  ),
                  cause,
                }),
            ),
          ),
        release: releaseEntry,
        detach: (input) =>
          Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const currentEntry = (yield* Ref.get(sessions)).get(key);
            let detachedProviderThreads: ReadonlyArray<OrchestrationV2ProviderThread> = [];
            if (currentEntry?.supportsMultipleProviderThreads === true) {
              const projection = yield* Effect.option(
                projectionStore.getThreadRecords(input.threadId, [
                  "providerThreads",
                  "providerTurns",
                ]),
              );
              if (Option.isSome(projection)) {
                const providerThreads = new Map(
                  projection.value.providerThreads
                    .filter((thread) => thread.providerSessionId === input.providerSessionId)
                    .map((thread) => [thread.id, thread] as const),
                );
                detachedProviderThreads = [...providerThreads.values()];
                const activeTurns = projection.value.providerTurns.filter(
                  (turn) => turn.status === "running" && providerThreads.has(turn.providerThreadId),
                );
                yield* Effect.forEach(
                  activeTurns,
                  (turn) =>
                    currentEntry.exposedRuntime
                      .interruptTurn({
                        providerThread: providerThreads.get(turn.providerThreadId)!,
                        providerTurnId: turn.id,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-interrupt-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerTurnId: turn.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                  { concurrency: 1, discard: true },
                );
              }
            }
            const detachResult = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || !entry.attachedThreadIds.has(input.threadId)) {
                return [
                  Option.none<{
                    readonly entry: LiveSessionEntry;
                    readonly idleUnloadFiber: Fiber.Fiber<void, never> | null;
                  }>(),
                  current,
                ] as const;
              }
              const attachedThreadIds = new Set(entry.attachedThreadIds);
              attachedThreadIds.delete(input.threadId);
              const loadedProviderThreads = new Map(entry.loadedProviderThreads);
              for (const [id, loaded] of loadedProviderThreads) {
                if (loaded.threadId === input.threadId)
                  loadedProviderThreads.set(id, { ...loaded, key: undefined });
              }
              // For a plain (workspace-change) detach, the credential id stays
              // recorded: the thread may re-attach and reuse it, and
              // releaseEntry revokes it when the provider process finally goes
              // away. A terminal detach (archive/delete) prunes the record so
              // nothing vetoes the revocation below.
              const mcpCredentialIdByThread =
                input.revokeMcpCredential === true
                  ? (() => {
                      const pruned = new Map(entry.mcpCredentialIdByThread);
                      pruned.delete(input.threadId);
                      return pruned;
                    })()
                  : entry.mcpCredentialIdByThread;
              // Keep the native pointer until the detach's unload succeeds.
              const idleThreadUnloads = new Map(entry.idleThreadUnloads);
              const pending = idleThreadUnloads.get(input.threadId);
              if (pending !== undefined)
                idleThreadUnloads.set(input.threadId, { ...pending, fiber: null });
              const updatedEntry = {
                ...entry,
                attachedThreadIds,
                loadedProviderThreads,
                mcpCredentialIdByThread,
                idleThreadUnloads,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [
                Option.some({
                  entry: updatedEntry,
                  idleUnloadFiber: entry.idleThreadUnloads.get(input.threadId)?.fiber ?? null,
                }),
                updated,
              ] as const;
            });
            if (Option.isSome(detachResult)) {
              yield* cancelIdleFiber(detachResult.value.idleUnloadFiber);
            }
            const detached = Option.map(detachResult, (result) => result.entry);
            // Plain detaches deliberately do not revoke: a detached thread's
            // provider process may still be alive (shared multi-thread codex
            // session across a workspace handoff) and holds its MCP client's
            // credential for the thread it will re-attach with. Credentials
            // are revoked when the session entry is released (process gone)
            // or rotated on the next attach if they stopped resolving.
            // Terminal detaches (thread archived or deleted) revoke the
            // thread's credentials immediately, even on a retry where the
            // entry is already gone: there is no legitimate future re-attach,
            // and the token must not outlive the thread.
            if (input.revokeMcpCredential === true) {
              yield* clearMcpSession(input.threadId);
            }
            if (Option.isNone(detached)) {
              return;
            }
            if (
              detached.value.attachedThreadIds.size === 0 &&
              !detached.value.supportsMultipleProviderThreads
            ) {
              yield* releaseEntry({
                providerSessionId: input.providerSessionId,
                reason: "manual_shutdown",
                ...(input.detail === undefined ? {} : { detail: input.detail }),
                detachedThreadId: input.threadId,
              });
              return;
            }
            // The shared runtime stays up for other threads, so unload this
            // thread's native state rather than leaving it (and its MCP
            // servers) resident until the whole runtime is released.
            const unloadThread = detached.value.exposedRuntime.unloadThread;
            if (detached.value.supportsMultipleProviderThreads && unloadThread !== undefined) {
              // Serialized with re-attachment: a thread whose next turn
              // attaches first stays loaded, and one that attaches during the
              // unload waits for it, so its resume reloads the native thread.
              yield* threadAttachment.withLock(
                threadAttachmentKey(input),
                Effect.gen(function* () {
                  const entry = (yield* Ref.get(sessions)).get(key);
                  if (
                    entry?.runtime !== detached.value.runtime ||
                    entry.attachedThreadIds.has(input.threadId)
                  ) {
                    return;
                  }
                  const pending = entry.idleThreadUnloads.get(input.threadId);
                  const providerThreads = new Map(
                    detachedProviderThreads.map(
                      (thread) => [providerThreadRuntimeKey(thread), thread] as const,
                    ),
                  );
                  if (pending !== undefined)
                    providerThreads.set(
                      providerThreadRuntimeKey(pending.providerThread),
                      pending.providerThread,
                    );
                  for (const loaded of entry.loadedProviderThreads.values()) {
                    if (loaded.threadId === input.threadId)
                      providerThreads.set(
                        providerThreadRuntimeKey(loaded.providerThread),
                        loaded.providerThread,
                      );
                  }
                  const fallbackCredentialId =
                    entry.mcpCredentialIdByThread.get(input.threadId) ??
                    Array.from(entry.loadedProviderThreads.values()).find(
                      (loaded) => loaded.threadId === input.threadId,
                    )?.mcpCredentialId;
                  yield* Ref.update(sessions, (current) => {
                    const latest = current.get(key);
                    if (latest?.runtime !== entry.runtime) return current;
                    const loadedProviderThreads = new Map(latest.loadedProviderThreads);
                    for (const providerThread of providerThreads.values()) {
                      if (
                        providerThread.nativeThreadRef !== null &&
                        !loadedProviderThreads.has(providerThreadRuntimeKey(providerThread))
                      ) {
                        loadedProviderThreads.set(providerThreadRuntimeKey(providerThread), {
                          threadId: input.threadId,
                          providerThread,
                          key: undefined,
                          mcpCredentialId: fallbackCredentialId,
                        });
                      }
                    }
                    return new Map(current).set(key, { ...latest, loadedProviderThreads });
                  });
                  yield* Effect.forEach(
                    [...providerThreads.values()].filter(
                      (thread) => thread.nativeThreadRef !== null,
                    ),
                    (providerThread) =>
                      unloadThread({ providerThread }).pipe(
                        // Bounded so a wedged provider cannot hold up the
                        // thread's next attach.
                        Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-unload-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerThreadId: providerThread.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                    { concurrency: 1, discard: true },
                  );
                  yield* Ref.update(sessions, (current) => {
                    const latest = current.get(key);
                    if (
                      latest?.runtime !== entry.runtime ||
                      latest.attachedThreadIds.has(input.threadId) ||
                      latest.idleThreadUnloads.get(input.threadId) !== pending ||
                      (pending !== undefined &&
                        latest.loadedProviderThreads.has(
                          providerThreadRuntimeKey(pending.providerThread),
                        ))
                    )
                      return current;
                    const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                    idleThreadUnloads.delete(input.threadId);
                    return new Map(current).set(key, { ...latest, idleThreadUnloads });
                  });
                }),
              );
            }
            yield* scheduleIdleRelease(input.providerSessionId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                new ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  cause,
                }),
              ),
            ),
          ),
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();
