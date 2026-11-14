import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  GROK_USAGE_URL,
  GrokUsageResponse,
  grokUsageResponseToLimits,
} from "@t3tools/provider-grok/server";
import { codexPlanLabel } from "../provider/CodexProvider.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import {
  antigravityAccountFingerprint,
  antigravitySummaryWindows,
  antigravityUserAgent,
} from "../provider/antigravityUsageLimits.ts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

/** A hub with its management key already read from wherever the setting keeps it. */
export interface CliproxyHub {
  readonly url: UsageLimitSourceConfig["url"];
  readonly managementKey: string;
}

const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  quota_router_subscription_ends_at: Schema.optional(Schema.Unknown),
  project_id: Schema.optional(Schema.String),
  id_token: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_plan_type: Schema.optional(Schema.String),
      plan_type: Schema.optional(Schema.String),
    }),
  ),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  limit_window_seconds: Schema.optional(Schema.Number),
});
const CodexUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    }),
  ),
  // Fork: pay-as-you-go credits; the balance arrives as decimal text or a number.
  credits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        has_credits: Schema.optional(Schema.NullOr(Schema.Boolean)),
        unlimited: Schema.optional(Schema.NullOr(Schema.Boolean)),
        balance: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
      }),
    ),
  ),
});
const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  spend: Schema.optional(Schema.Unknown),
  extra_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        is_enabled: Schema.Boolean,
        monthly_limit: Schema.NullOr(Schema.Number),
        used_credits: Schema.NullOr(Schema.Number),
        utilization: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const CreditList = Schema.Struct({
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const Control = Schema.Struct({
  pins: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          session: Schema.String,
          account: Schema.String,
          stall: Schema.optional(Schema.Boolean),
          move: Schema.optional(Schema.Boolean),
          expires_at: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  steers: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          account: Schema.String,
          expires_at: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  held: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          session: Schema.String,
          account: Schema.optional(Schema.String),
          since: Schema.optional(Schema.String),
          release_at: Schema.String,
          reset_at: Schema.optional(Schema.NullOr(Schema.String)),
          window: Schema.optional(Schema.String),
          kind: Schema.optional(Schema.String),
          reason: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  // Quota router 0.12: declared subscription ends; 0.14.6: per-session safety-margin overrides.
  ends: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          account: Schema.String,
          provider: Schema.optional(Schema.String),
          ends_at: Schema.String,
        }),
      ),
    ),
  ),
  margins: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          session: Schema.String,
          headroom_scale: Schema.Number,
          expires_at: Schema.String,
          actor: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
  // Quota router 0.28: its alias for each host auth slot; null until it has listed them.
  accounts: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          account: Schema.String,
          provider: Schema.String,
          auth_index: Schema.optional(Schema.String),
          legacy_account: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
});

/**
 * A router's `accounts` from GET control: a list names every account, null means it has not
 * listed them yet, and undefined (routers before 0.28.0) means T3 computes the legacy aliases.
 */
export type RouterListing = (typeof Control.Type)["accounts"];

// Fork: quota-router 0.22 previews the account its next pick for a session would use.
const NextPick = Schema.Struct({
  account: Schema.optional(Schema.NullOr(Schema.String)),
  basis: Schema.optional(Schema.String),
  reset_at: Schema.optional(Schema.NullOr(Schema.String)),
  // Quota router 0.24: an account-bound conversation's established account.
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  // Newer routers: the request kind answered for, the conversation's account now, and the
  // context size at which the small-context switch can change the pick.
  kind: Schema.optional(Schema.String),
  current: Schema.optional(Schema.NullOr(Schema.String)),
  switch_below_context_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
});

const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const decodeControl = Schema.decodeUnknownEffect(Control);
const decodeNextPick = Schema.decodeUnknownEffect(NextPick);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditList));
const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeUsage));
const decodeCodexUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexUsage));
const decodeGrokUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(GrokUsageResponse));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeAliasInput = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

// Extra CAs can fix untrusted chains; expiry/hostname failures report codes only.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// fetch wraps Node error codes in generic TypeErrors.
const nodeErrorCode = (cause: unknown) => {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
};

// Hub responses can contain credentials; expose only failure kind, HTTP status or Node code.
const describeManagementFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "The hub did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `The hub answered with HTTP ${reason.response.status}.`;
    }
    const code = reason._tag === "TransportError" ? nodeErrorCode(reason.cause) : undefined;
    if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
      return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
    }
    if (code !== undefined) return `The hub request failed (${code}).`;
  }
  return "The hub management request failed.";
};
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
const creditRedeemRequestId = Effect.fn("CliproxyApi.creditRedeemRequestId")(function* (
  accountId: string,
  creditId: string,
) {
  const digest = yield* Digest.Digest;
  const name = new TextEncoder().encode(`${accountId}:${creditId}`);
  const input = new Uint8Array(CREDIT_REDEEM_NAMESPACE.length + name.length);
  input.set(CREDIT_REDEEM_NAMESPACE);
  input.set(name, CREDIT_REDEEM_NAMESPACE.length);
  const bytes = (yield* digest.digest(Digest.sha1, input).pipe(Effect.orDie)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

type AuthFile = typeof AuthFile.Type;
/** Sends one upstream request with the account's token, as GET or as a JSON POST of `data`. */
type HubCall = (
  url: string,
  data?: unknown,
) => Effect.Effect<string, UsageLimitSourceError | Schema.SchemaError>;
type HubReading = Omit<UsageLimitSourceAccount, "id" | "driver">;
interface HubProvider {
  readonly driver: ProviderDriverKind;
  readonly header: (
    account: AuthFile,
    platform: NodeJS.Platform,
    architecture: NodeJS.Architecture,
  ) => Record<string, string>;
  readonly read: (input: {
    readonly account: AuthFile;
    readonly call: HubCall;
    readonly checkedAt: string;
  }) => Effect.Effect<HubReading, UsageLimitSourceError | Schema.SchemaError, Digest.Digest>;
}

const listedIdentity = (account: AuthFile) => {
  const subscriptionEnd =
    typeof account.quota_router_subscription_ends_at === "string"
      ? Option.getOrUndefined(DateTime.make(account.quota_router_subscription_ends_at))
      : undefined;
  return {
    ...(subscriptionEnd ? { subscriptionEndsAt: DateTime.formatIso(subscriptionEnd) } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.id_token?.chatgpt_account_id?.trim()
      ? { workspaceId: account.id_token.chatgpt_account_id.trim() }
      : {}),
  };
};

const credits = Effect.fn("CliproxyApi.credits")(function* (call: HubCall) {
  const response = yield* decodeCreditList(yield* call(CREDIT_URL));
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  return response.credits
    .filter(
      (credit) =>
        credit.reset_type === "codex_rate_limits" &&
        credit.status === "available" &&
        Date.parse(credit.expires_at) > now,
    )
    .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
});

const CODEX_HUB: HubProvider = {
  driver: ProviderDriverKind.make("codex"),
  header: (account) => ({
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "OpenAI-Beta": "codex-1",
    Originator: "Codex Desktop",
    ...(account.id_token?.chatgpt_account_id
      ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id }
      : {}),
  }),
  read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
    const usage = yield* decodeCodexUsage(yield* call(`${CODEX_BASE}/usage`));
    const toWindow = (window: typeof CodexWindow.Type | null | undefined) =>
      window
        ? {
            usedPercent: window.used_percent,
            resetsAt: window.reset_at ?? null,
            ...(window.limit_window_seconds === undefined
              ? {}
              : { windowDurationMins: window.limit_window_seconds / 60 }),
          }
        : null;
    const available = yield* credits(call).pipe(Effect.orElseSucceed(() => undefined));
    const next = available?.[0];
    const planType =
      usage.plan_type ?? account.id_token?.plan_type ?? account.id_token?.chatgpt_plan_type;
    return {
      ...listedIdentity(account),
      plan: codexPlanLabel(planType),
      usageLimits: {
        ...codexRateLimitsToLimits({
          checkedAt,
          snapshot: {
            planType: planType ?? null,
            primary: toWindow(usage.rate_limit?.primary_window),
            secondary: toWindow(usage.rate_limit?.secondary_window),
            credits: usage.credits
              ? {
                  hasCredits: usage.credits.has_credits ?? false,
                  unlimited: usage.credits.unlimited ?? false,
                  balance: usage.credits.balance == null ? null : String(usage.credits.balance),
                }
              : null,
          },
        }),
        ...(available
          ? {
              resetCredits: {
                availableCount: available.length,
                ...(next
                  ? {
                      nextCreditId: next.id,
                      nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
  }),
};

const GROK_CLI_VERSION = "1.0.77";
const ANTIGRAVITY_SUMMARY_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

// Keyed by the auth-files `provider`; accounts of any other provider are skipped.
const HUB_PROVIDERS = new Map<string, HubProvider>([
  ["codex", CODEX_HUB],
  [
    "claude",
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      header: () => ({
        Authorization: "Bearer $TOKEN$",
        "anthropic-beta": "oauth-2025-04-20",
        // The OAuth usage endpoint can return 429 without a Claude Code user agent.
        "User-Agent": "claude-code/2.1.273",
      }),
      read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
        const usage = yield* decodeClaudeUsage(
          yield* call("https://api.anthropic.com/api/oauth/usage"),
        );
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        const rateLimits = {
          five_hour: usage.five_hour ?? null,
          seven_day: usage.seven_day ?? null,
          model_scoped,
          spend: usage.spend,
          extra_usage: usage.extra_usage ?? null,
        };
        return {
          ...listedIdentity(account),
          plan: "Claude Subscription",
          usageLimits: claudeUsageResponseToLimits({
            checkedAt,
            response: { rate_limits_available: true, rate_limits: rateLimits },
          }).limits,
        };
      }),
    },
  ],
  [
    "xai",
    {
      driver: ProviderDriverKind.make("grok"),
      header: () => ({
        Authorization: "Bearer $TOKEN$",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": GROK_CLI_VERSION,
        "User-Agent": `grok-cli/${GROK_CLI_VERSION}`,
      }),
      read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
        const usage = yield* decodeGrokUsage(yield* call(GROK_USAGE_URL));
        return {
          ...listedIdentity(account),
          usageLimits: grokUsageResponseToLimits(usage, checkedAt),
        };
      }),
    },
  ],
  [
    "antigravity",
    {
      driver: ProviderDriverKind.make("antigravity"),
      header: (_account, platform, architecture) => ({
        Authorization: "Bearer $TOKEN$",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(platform, architecture),
      }),
      read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
        const project = account.project_id?.trim();
        if (!project) {
          return yield* new UsageLimitSourceError({ detail: "No Antigravity project reported." });
        }
        const requestedAt = DateTime.toEpochMillis(yield* DateTime.now);
        const summary = yield* call(ANTIGRAVITY_SUMMARY_URL, { project });
        const windows = yield* antigravitySummaryWindows(yield* decodeJson(summary), requestedAt);
        if (windows.length === 0) {
          return yield* new UsageLimitSourceError({ detail: "No Antigravity quota reported." });
        }
        // Local Antigravity reports no e-mail, so the Google account fingerprint is what pools the two.
        const fingerprint = yield* call("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
          Effect.flatMap(decodeJson),
          Effect.flatMap(antigravityAccountFingerprint),
          Effect.option,
        );
        const usageLimits = makeUsageLimits({ checkedAt, windows });
        return Option.match(fingerprint, {
          onNone: () => ({ ...listedIdentity(account), usageLimits }),
          onSome: (credentialFingerprint) => ({
            usageLimits: { ...usageLimits, credentialFingerprint },
          }),
        });
      }),
    },
  ],
]);

/** The router's provider name for a driver whose sessions it can pin. */
const ROUTER_PROVIDERS = { claudeAgent: "claude", codex: "codex" } as const;
export type RouterProvider = (typeof ROUTER_PROVIDERS)[keyof typeof ROUTER_PROVIDERS];
export const routerProviderOf = (driver: string): RouterProvider | undefined =>
  Object.hasOwn(ROUTER_PROVIDERS, driver)
    ? ROUTER_PROVIDERS[driver as keyof typeof ROUTER_PROVIDERS]
    : undefined;

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const mac = yield* Mac.Mac;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const management = Effect.fn("CliproxyApi.management")(function* (
    hub: CliproxyHub,
    path: string,
    body?: unknown,
    // `conflict` replaces the generic text for an HTTP 409, whose body stays unread like any other.
    options: { readonly method?: "DELETE" | "PUT"; readonly conflict?: string } = {},
  ) {
    const url = yield* Effect.try({
      try: () => {
        const base = new URL(hub.url);
        // Users often paste the hub's web panel URL, which ends in management.html.
        base.pathname = base.pathname.replace(/(\/management\.html)?\/?$/i, "/");
        return new URL(`v0/management/${path}`, base).toString();
      },
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      body === undefined
        ? HttpClientRequest.get(url)
        : HttpClientRequest.make(options.method ?? "POST")(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${hub.managementKey}`));
    const response = yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (error) =>
            new UsageLimitSourceError({
              detail:
                options.conflict !== undefined &&
                HttpClientError.isHttpClientError(error) &&
                error.reason._tag === "StatusCodeError" &&
                error.reason.response.status === 409
                  ? options.conflict
                  : describeManagementFailure(error),
            }),
        ),
      );
    return response;
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (hub: CliproxyHub) {
    const response = yield* management(hub, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    header: Record<string, string>,
    url: string,
    data?: unknown,
  ) {
    const raw = yield* management(hub, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new UsageLimitSourceError({
        detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
      });
    }
    return response.body;
  });

  // A router before 0.28.0 names an account "account-" plus 16 hex of HMAC-SHA256, keyed by the
  // management key, over JSON.stringify([provider, auth_index]); later ones publish their aliases.
  const routerAliasOf = Effect.fn("CliproxyApi.routerAliasOf")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    listing: RouterListing,
  ) {
    if (listing !== undefined) {
      return listing?.find(
        (entry) => entry.provider === account.provider && entry.auth_index === account.auth_index,
      )?.account;
    }
    const utf8 = (value: string) => new TextEncoder().encode(value);
    const key = yield* Mac.key(Mac.hmacSha256, utf8(hub.managementKey));
    const signed = yield* encodeAliasInput([account.provider, account.auth_index]);
    return `account-${Hex.encode(yield* mac.sign(key, utf8(signed))).slice(0, 16)}`;
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    provider: HubProvider,
    listing: Effect.Effect<RouterListing>,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const call: HubCall = (url, data) =>
      apiCall(hub, account, provider.header(account, platform, architecture), url, data);
    const [reading, routerAlias] = yield* Effect.all(
      [
        provider.read({ account, call, checkedAt }).pipe(
          Effect.provideService(Digest.Digest, digest),
          Effect.orElseSucceed(() => ({
            ...listedIdentity(account),
            usageLimits: makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "The hub could not read this account's usage.",
            }),
          })),
        ),
        listing.pipe(
          Effect.flatMap((names) => routerAliasOf(hub, account, names)),
          Effect.orElseSucceed(() => undefined),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      id: account.id,
      driver: provider.driver,
      ...(routerAlias === undefined ? {} : { routerAlias }),
      ...reading,
    };
  });

  /** `listing` is the router's account listing, read only when the hub lists an account. */
  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    hub: CliproxyHub,
    listing: Effect.Effect<RouterListing> = Effect.undefined,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(hub).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    const names = yield* Effect.cached(listing);
    return yield* Effect.forEach(
      accounts.flatMap((account) => {
        const provider = HUB_PROVIDERS.get(account.provider);
        return provider && !account.disabled ? [{ account, provider }] : [];
      }),
      ({ account, provider }) => readAccount(hub, account, provider, names),
      { concurrency: 4 },
    );
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    hub: CliproxyHub,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(hub)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(
        hub,
        account,
        CODEX_HUB.header(account, platform, architecture),
        `${CREDIT_URL}/consume`,
        {
          redeem_request_id: yield* creditRedeemRequestId(
            account.id_token?.chatgpt_account_id ?? account.id,
            creditId,
          ).pipe(Effect.provideService(Digest.Digest, digest)),
          credit_id: creditId,
        },
      );
      const response = yield* decodeConsumeResponse(body);
      const outcome = (
        {
          reset: "reset",
          nothing_to_reset: "nothingToReset",
          no_credit: "noCredit",
          already_redeemed: "alreadyRedeemed",
        } as const
      )[response.code];
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = yield* management(hub, "reset-quota", {
        auth_index: account.auth_index,
      }).pipe(Effect.result);
      return {
        outcome,
        ...(cleared._tag === "Failure"
          ? {
              warning:
                "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
            }
          : {}),
      } as const;
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: "The hub returned an unexpected reset-credit response.",
            }),
      ),
    );
  });
  // Quota-router control: `held` also lists stall pins (kind "pin", or no kind from older routers).
  // `listing` comes from the same read, to name the holds' accounts.
  const keepWarmHolds = Effect.fn("CliproxyApi.keepWarmHolds")(function* (config: CliproxyHub) {
    const control = yield* management(config, "control").pipe(Effect.flatMap(decodeControl));
    // Go writes RFC3339 with nanoseconds or offsets; clients compare ISO strings.
    const iso = (value: string | null | undefined) =>
      value ? Option.getOrNull(Option.map(DateTime.make(value), DateTime.formatIso)) : null;
    const holds = (control.held ?? []).flatMap((held) => {
      const releaseAt = iso(held.release_at);
      const resetAt = iso(held.reset_at);
      return held.kind === "keep_warm" && releaseAt !== null && resetAt !== null
        ? [{ session: held.session, account: held.account, releaseAt, resetAt }]
        : [];
    });
    return { holds, listing: control.accounts };
  });

  /**
   * Forwards the sessions' held requests now and stops holding them until `expiresAt`. With
   * `switchAccount` (quota router 0.23.0) the router instead moves each conversation's held
   * requests to another account once one can take them, or answers 409 when the conversation has
   * no hold it may move; older routers treat it as a plain release.
   */
  const releaseKeepWarm = Effect.fn("CliproxyApi.releaseKeepWarm")(function* (
    config: CliproxyHub,
    sessions: ReadonlyArray<string>,
    expiresAt: string,
    switchAccount = false,
  ) {
    yield* management(
      config,
      "control/keep-warm",
      { sessions, expires_at: expiresAt, ...(switchAccount ? { switch: true } : {}) },
      { conflict: "This conversation cannot switch accounts right now." },
    );
  });

  // Undoes `releaseKeepWarm`: the sessions' later requests can be held again.
  const restoreKeepWarm = Effect.fn("CliproxyApi.restoreKeepWarm")(function* (
    config: CliproxyHub,
    sessions: ReadonlyArray<string>,
  ) {
    yield* management(config, "control/keep-warm", { sessions }, { method: "DELETE" });
  });

  /**
   * The quota router's reset for the account it would route this session to next. `null` means the
   * hub cannot preview picks (stock CLIProxyAPI or an older router); a known pick may still have an unknown reset.
   */
  const nextPickReset = Effect.fn("CliproxyApi.nextPickReset")(function* (
    config: CliproxyHub,
    input: {
      readonly provider: RouterProvider;
      readonly session?: string;
      readonly model?: string;
    },
  ) {
    const pick = yield* nextPick(config, input);
    // No account means the router could not tell (no pool for the provider), unlike an unknown reset.
    if (pick === null || pick.account === null) return null;
    return { resetsAt: pick.resetsAt };
  });

  /**
   * The router's pick preview; null when the hub cannot preview picks. `kind` is the kind the
   * router answered for: null from routers that ignore the parameter and answer for the next
   * ordinary request. `keepWarm` says the requests carry `X-T3-Keep-Warm`, as Claude's do.
   */
  const nextPick = Effect.fn("CliproxyApi.nextPick")(function* (
    config: CliproxyHub,
    input: {
      readonly provider: RouterProvider;
      readonly session?: string;
      readonly model?: string;
      readonly kind?: "compaction";
      readonly keepWarm?: boolean;
    },
  ) {
    const query = new URLSearchParams({ provider: input.provider });
    if (input.session) query.set("session", input.session);
    if (input.model) query.set("model", input.model);
    if (input.kind) query.set("kind", input.kind);
    if (input.keepWarm) query.set("keep_warm", "1");
    const pick = yield* management(config, `control/next?${query}`).pipe(
      Effect.flatMap(decodeNextPick),
      Effect.tapError((error) =>
        Effect.logDebug("quota router could not preview its next pick", { error }),
      ),
      Effect.option,
    );
    if (Option.isNone(pick)) return null;
    const resetsAt = pick.value.reset_at
      ? Option.getOrNull(Option.map(DateTime.make(pick.value.reset_at), DateTime.formatIso))
      : null;
    return {
      account: pick.value.account ?? null,
      owner: pick.value.owner ?? null,
      resetsAt,
      basis: pick.value.basis ?? null,
      kind: pick.value.kind ?? null,
      current: pick.value.current ?? null,
      switchBelowContextTokens: pick.value.switch_below_context_tokens ?? null,
    };
  });

  const control = Effect.fn("CliproxyApi.control")(function* (config: CliproxyHub) {
    return yield* management(config, "control").pipe(
      Effect.flatMap(decodeControl),
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: "The hub returned an unexpected control response.",
            }),
      ),
    );
  });

  /**
   * Routes the sessions to `account` until `expiresAt` (at most seven days ahead). `move` (quota
   * router 0.24) lets the pin replace an account-bound conversation's owner; older routers ignore
   * it and would reject the conversation's requests, so their pin is withdrawn with an error. A
   * failed move is withdrawn too: the router can save the pin before failing to save the move.
   */
  const pin = Effect.fn("CliproxyApi.pin")(function* (
    config: CliproxyHub,
    input: {
      readonly sessions: ReadonlyArray<string>;
      readonly account: string;
      readonly stall: boolean;
      readonly expiresAt: string;
      readonly move?: boolean;
    },
  ) {
    const response = yield* management(
      config,
      "control/pin",
      {
        sessions: input.sessions,
        account: input.account,
        stall: input.stall,
        expires_at: input.expiresAt,
        ...(input.move ? { move: true } : {}),
      },
      { conflict: "The router refused the pin: this conversation is bound to another account." },
    ).pipe(
      Effect.tapError(() =>
        input.move ? unpin(config, input.sessions).pipe(Effect.ignore) : Effect.void,
      ),
    );
    if (!input.move) return;
    const reply = yield* decodeControl(response).pipe(Effect.option);
    const moved =
      Option.isSome(reply) &&
      input.sessions.every((session) =>
        (reply.value.pins ?? []).some((pin) => pin.session === session && pin.move === true),
      );
    if (moved) return;
    yield* unpin(config, input.sessions).pipe(Effect.ignore);
    return yield* new UsageLimitSourceError({
      detail:
        "This CLI Proxy quota router cannot move an account-bound conversation. Update it to 0.24.0 or later.",
    });
  });

  const unpin = Effect.fn("CliproxyApi.unpin")(function* (
    config: CliproxyHub,
    sessions: ReadonlyArray<string>,
  ) {
    yield* management(config, "control/pin", { sessions }, { method: "DELETE" });
  });

  const steer = Effect.fn("CliproxyApi.steer")(function* (
    config: CliproxyHub,
    account: string,
    expiresAt: string,
  ) {
    yield* management(
      config,
      "control/steer",
      { account, expires_at: expiresAt },
      { method: "PUT" },
    );
  });

  const unsteer = Effect.fn("CliproxyApi.unsteer")(function* (
    config: CliproxyHub,
    provider: RouterProvider,
  ) {
    yield* management(config, "control/steer", { provider }, { method: "DELETE" });
  });

  /**
   * Sets (`headroomScale` 0 to 1, until `expiresAt`) or, with null, clears a Claude session's
   * safety-margin override; `actor` is the audit label the router lists with it.
   */
  const margin = Effect.fn("CliproxyApi.margin")(function* (
    config: CliproxyHub,
    input: {
      readonly sessions: ReadonlyArray<string>;
      readonly headroomScale: number | null;
      readonly expiresAt: string;
      readonly actor: string;
    },
  ) {
    yield* input.headroomScale === null
      ? management(
          config,
          "control/margin",
          { sessions: input.sessions, actor: input.actor },
          { method: "DELETE" },
        )
      : management(config, "control/margin", {
          sessions: input.sessions,
          headroom_scale: input.headroomScale,
          expires_at: input.expiresAt,
          actor: input.actor,
        });
  });

  /** Declares, or with null removes, the account's subscription end. */
  const subscriptionEnd = Effect.fn("CliproxyApi.subscriptionEnd")(function* (
    config: CliproxyHub,
    account: string,
    endsAt: string | null,
  ) {
    yield* management(
      config,
      "control/end",
      endsAt === null ? { account } : { account, ends_at: endsAt },
      { method: endsAt === null ? "DELETE" : "PUT" },
    );
  });

  return {
    readAccounts,
    routerAliasOf,
    consume,
    authFiles,
    keepWarmHolds,
    releaseKeepWarm,
    restoreKeepWarm,
    nextPickReset,
    nextPick,
    control,
    pin,
    unpin,
    steer,
    unsteer,
    margin,
    subscriptionEnd,
  };
});

export type CliproxyApi = Effect.Success<typeof makeCliproxyApi>;
