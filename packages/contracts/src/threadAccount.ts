import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  RouterAccountAlias,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
} from "./providerUsageLimits.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/**
 * The router account a thread's requests go to. `stall` waits for that account when it runs out;
 * otherwise the router falls back to another account.
 */
export const ThreadAccountChoice = Schema.Struct({
  /** The hub whose router holds the pin. */
  sourceId: UsageLimitSourceId,
  account: RouterAccountAlias,
  stall: Schema.Boolean,
  /** The provider instance the choice was made for; absent on choices stored before it was kept. */
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ThreadAccountChoice = typeof ThreadAccountChoice.Type;

/** The choice when it applies to `instanceId`; a provider or model switch leaves it stale. */
export const threadAccountChoiceFor = (
  choice: ThreadAccountChoice | null | undefined,
  instanceId: string,
): ThreadAccountChoice | null =>
  choice && (choice.instanceId === undefined || choice.instanceId === instanceId) ? choice : null;

/** Shown before, and returned instead of, moving a conversation its account owns. */
export const THREAD_ACCOUNT_MOVE_WARNING =
  "This conversation is bound to its current account, so switching drops its earlier thinking (it is tied to that account; messages, tool results and files stay) and re-sends the context as a cold cache write.";

/**
 * `modelSelection` is what the thread's next message would use: the composer's unsent choice, else
 * the thread's. A draft with no server thread yet omits `threadId`.
 */
export const ThreadAccountStateInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  modelSelection: ModelSelection,
});
export type ThreadAccountStateInput = typeof ThreadAccountStateInput.Type;

/** Null when the provider instance does not route through one quota-router hub with two or more accounts. */
export const ThreadAccountState = Schema.NullOr(
  Schema.Struct({
    sourceId: UsageLimitSourceId,
    instanceId: ProviderInstanceId,
    /** The hub's accounts for the provider, each with its `routerAlias`. */
    accounts: Schema.Array(UsageLimitSourceAccount),
    /** The account the router would use for this thread's next request, when it can tell. */
    next: Schema.NullOr(RouterAccountAlias),
    /** The account new threads of this provider prefer. */
    steer: Schema.NullOr(RouterAccountAlias),
    /** The account an account-bound conversation is tied to; only an explicit move changes it. */
    owner: Schema.NullOr(RouterAccountAlias),
  }),
);
export type ThreadAccountState = typeof ThreadAccountState.Type;

/** `account: null` returns the thread to automatic routing. */
export const ThreadAccountSetInput = Schema.Struct({
  threadId: ThreadId,
  account: Schema.NullOr(RouterAccountAlias),
  stall: Schema.optional(Schema.Boolean),
  /** Acknowledges THREAD_ACCOUNT_MOVE_WARNING; required to move an owned conversation. */
  dropThinking: Schema.optional(Schema.Boolean),
});
export type ThreadAccountSetInput = typeof ThreadAccountSetInput.Type;

/** The quota router's provider names, which its steers are keyed by. */
export const RouterProvider = Schema.Literals(["claude", "codex"]);
export type RouterProvider = typeof RouterProvider.Type;

/**
 * `account: null` lets the router place new threads of the provider again. The second form needs
 * no provider instance: an account names its hub and provider, and a clear names the provider
 * (on `sourceId`, else on every hub listing its accounts).
 */
export const ThreadAccountSteerInput = Schema.Union([
  Schema.Struct({
    instanceId: ProviderInstanceId,
    account: Schema.NullOr(RouterAccountAlias),
  }),
  Schema.Struct({
    sourceId: Schema.optional(UsageLimitSourceId),
    provider: Schema.optional(RouterProvider),
    account: Schema.NullOr(RouterAccountAlias),
  }),
]);
export type ThreadAccountSteerInput = typeof ThreadAccountSteerInput.Type;

export const ThreadAccountRoutingInput = Schema.Struct({ sourceId: UsageLimitSourceId });
export type ThreadAccountRoutingInput = typeof ThreadAccountRoutingInput.Type;

const RoutedThread = Schema.NullOr(Schema.Struct({ id: ThreadId, title: Schema.String }));

/**
 * A hub's controls as its router lists them (`GET control`), joined to T3 threads by native
 * session. `active: false` marks a choice T3 stores that the router does not list, such as an
 * expired pin that the thread's next turn re-applies. `thread` is null for a session T3 does not
 * know, which `session` (a native session id prefix) names. Null when the hub is disabled or keyless.
 */
export const ThreadAccountRouting = Schema.NullOr(
  Schema.Struct({
    steers: Schema.Array(
      Schema.Struct({
        provider: RouterProvider,
        account: RouterAccountAlias,
        active: Schema.Boolean,
        expiresAt: Schema.optional(IsoDateTime),
      }),
    ),
    pins: Schema.Array(
      Schema.Struct({
        account: RouterAccountAlias,
        stall: Schema.Boolean,
        active: Schema.Boolean,
        /** Absent on a stored choice the router does not list. */
        expiresAt: Schema.optional(IsoDateTime),
        thread: RoutedThread,
        session: Schema.NullOr(Schema.String),
      }),
    ),
    /** Requests the router is holding now: `pin` for a stall pin, `keep_warm` for a warm cache. */
    held: Schema.optional(
      Schema.Array(
        Schema.Struct({
          account: Schema.NullOr(RouterAccountAlias),
          kind: Schema.String,
          releaseAt: IsoDateTime,
          resetAt: Schema.NullOr(IsoDateTime),
          thread: RoutedThread,
          session: Schema.NullOr(Schema.String),
        }),
      ),
    ),
    /** Timed safety-margin overrides: `headroomScale` 0 drops the router's spare headroom. */
    margins: Schema.optional(
      Schema.Array(
        Schema.Struct({
          headroomScale: Schema.Number,
          expiresAt: IsoDateTime,
          actor: Schema.NullOr(Schema.String),
          thread: RoutedThread,
          session: Schema.NullOr(Schema.String),
        }),
      ),
    ),
    /** Declared subscription ends; they stay until removed, also once passed. */
    ends: Schema.optional(
      Schema.Array(Schema.Struct({ account: RouterAccountAlias, endsAt: IsoDateTime })),
    ),
  }),
);
export type ThreadAccountRouting = typeof ThreadAccountRouting.Type;

/** `headroomScale: null` clears the thread's override; `until` defaults to one hour from now. */
export const ThreadAccountMarginInput = Schema.Struct({
  threadId: ThreadId,
  headroomScale: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  until: Schema.optional(IsoDateTime),
});
export type ThreadAccountMarginInput = typeof ThreadAccountMarginInput.Type;

/** `endsAt: null` removes the declaration. */
export const ThreadAccountEndInput = Schema.Struct({
  account: RouterAccountAlias,
  endsAt: Schema.NullOr(IsoDateTime),
});
export type ThreadAccountEndInput = typeof ThreadAccountEndInput.Type;

const UsageWindowSummary = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(IsoDateTime),
});

/** One account's quota as the server last read it, without credential details. */
export const AccountUsageSummary = Schema.Struct({
  driver: ProviderDriverKind,
  /** The router alias for a hub account, which pins, steers and ends name. */
  account: Schema.optional(RouterAccountAlias),
  email: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  subscriptionEndsAt: Schema.optional(IsoDateTime),
  checkedAt: IsoDateTime,
  windows: Schema.Array(UsageWindowSummary),
  usageCredits: ServerProviderUsageLimits.fields.usageCredits,
  /** Banked rate-limit resets the account could redeem. */
  resetCredits: Schema.optional(Schema.Number),
  /** Present when resets differ in what they refill; redeem one by its `creditId`. */
  resetCreditOptions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        creditId: Schema.String,
        label: Schema.String,
        availableCount: Schema.Number,
      }),
    ),
  ),
  unavailable: Schema.optional(Schema.String),
});
export type AccountUsageSummary = typeof AccountUsageSummary.Type;

export const ThreadAccountUsageInput = Schema.Struct({ threadId: Schema.optional(ThreadId) });
export type ThreadAccountUsageInput = typeof ThreadAccountUsageInput.Type;

/** Every account's usage and each hub's routing; `thread` only when one was asked about. */
export const ThreadAccountUsage = Schema.Struct({
  /** Whether the user lets agents redeem reset credits. */
  agentsCanRedeemResetCredits: Schema.Boolean,
  native: Schema.Array(
    Schema.Struct({ instanceId: ProviderInstanceId, ...AccountUsageSummary.fields }),
  ),
  hubs: Schema.Array(
    Schema.Struct({
      sourceId: UsageLimitSourceId,
      label: Schema.String,
      error: Schema.optional(Schema.String),
      accounts: Schema.Array(AccountUsageSummary),
      /** Null when the hub has no quota router to read. */
      routing: ThreadAccountRouting,
    }),
  ),
  thread: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      /** The account the router would send the thread's next request to. */
      next: Schema.NullOr(RouterAccountAlias),
      /** The account an account-bound conversation is tied to. */
      owner: Schema.NullOr(RouterAccountAlias),
      chosen: Schema.NullOr(
        Schema.Struct({ account: RouterAccountAlias, waitWhenOut: Schema.Boolean }),
      ),
    }),
  ),
});
export type ThreadAccountUsage = typeof ThreadAccountUsage.Type;

export class ThreadAccountError extends Schema.TaggedError<ThreadAccountError>()(
  "ThreadAccountError",
  {
    detail: Schema.String,
    /** Set when the request needs `dropThinking: true` to move an owned conversation. */
    requiresDropThinking: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
