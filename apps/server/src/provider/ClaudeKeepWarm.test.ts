import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ClaudeKeepWarmActionError,
  MessageId,
  ProviderTurnId,
  RunId,
  SecretProviderId,
  ThreadId,
  UsageLimitSourceId,
  type ClaudeKeepWarmHold,
  type OrchestrationV2ServerCommand,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ClaudeKeepWarmActions from "../orchestration-v2/ClaudeKeepWarmActions.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeKeepWarm from "./ClaudeKeepWarm.ts";

const threadId = ThreadId.make("thread-keep-warm");
const hold = { resetAt: "2026-11-03T15:00:00.000Z", releaseAt: "2026-11-03T13:59:00.000Z" };

it("allows keep-warm holds without replacing an explicit stream idle timeout", () => {
  const environment = { ANTHROPIC_CUSTOM_HEADERS: "X-Existing: 1" };
  const defaults = ClaudeKeepWarm.keepWarmClaudeEnvironment(environment);
  assert.equal(defaults.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "3600000");
  assert.equal(defaults.ANTHROPIC_CUSTOM_HEADERS, "X-Existing: 1\nX-T3-Keep-Warm: 1");
  assert.deepEqual(environment, { ANTHROPIC_CUSTOM_HEADERS: "X-Existing: 1" });
  assert.equal(
    ClaudeKeepWarm.keepWarmClaudeEnvironment({ CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1200000" })
      .CLAUDE_STREAM_IDLE_TIMEOUT_MS,
    "1200000",
  );
});

function fixture(
  control: { status: number; body: unknown },
  managementKey: SettingsSecretValue = "key",
) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      assert.equal(request.headers.authorization, "Bearer key");
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, path: new URL(request.url).pathname, body });
      return HttpClientResponse.fromWeb(
        request,
        request.method === "GET"
          ? Response.json(control.body, { status: control.status })
          : Response.json({}),
      );
    }),
  );
  const layer = Layer.effect(ClaudeKeepWarm.ClaudeKeepWarm, ClaudeKeepWarm.make).pipe(
    Layer.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "https://hub.test",
            managementKey,
            enabled: true,
          },
        },
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) => Effect.succeed(references.map(() => "key")),
        invalidate: () => Effect.void,
      }),
      NodeCrypto.layer,
    ]),
  );
  return { requests, layer };
}

function fakeSession(session: string, index: number) {
  const shown: Array<ClaudeKeepWarmHold | null> = [];
  const paused: Array<ClaudeKeepWarmHold> = [];
  let hold: ClaudeKeepWarmHold | null = null;
  const turn = () => ({
    threadId: ThreadId.make(`${threadId}-${index}`),
    runId: RunId.make(`run-${index}`),
    providerTurnId: ProviderTurnId.make(`turn-${index}`),
    session,
    hold,
  });
  return {
    shown,
    paused,
    session: {
      turn: Effect.sync(turn),
      show: (_turn, next) =>
        Effect.sync(() => {
          hold = next;
          shown.push(next);
        }),
      pause: (_turn, next) => Effect.sync(() => void paused.push(next)),
    } satisfies ClaudeKeepWarm.ClaudeKeepWarmSession,
  };
}

it.effect("shows only keep-warm holds of the session, with one control read per interval", () => {
  const { requests, layer } = fixture(
    {
      status: 200,
      body: {
        pins: [],
        held: [
          { session: "root", kind: "pin", release_at: "2026-11-03T13:00:00Z", window: "5h" },
          { session: "root", release_at: "2026-11-03T13:00:00Z", window: "5h" },
          {
            session: "root",
            kind: "keep_warm",
            since: "2026-11-03T13:00:00Z",
            release_at: "2026-11-03T14:30:00.123456789Z",
            reset_at: "2026-11-03T15:00:00Z",
          },
          {
            session: "root",
            kind: "keep_warm",
            release_at: "2026-11-03T13:59:00+00:00",
            reset_at: "2026-11-03T15:00:00Z",
          },
          {
            session: "other",
            kind: "keep_warm",
            release_at: "2026-11-03T13:10:00Z",
            reset_at: "2026-11-03T15:00:00Z",
          },
        ],
      },
    },
    { provider: SecretProviderId.make("vault"), reference: "cliproxy#key" },
  );
  return Effect.gen(function* () {
    const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;
    const first = fakeSession("root", 1);
    const second = fakeSession("quiet", 2);
    yield* keepWarm.register(first.session);
    yield* keepWarm.register(second.session);
    yield* TestClock.adjust("30 seconds");
    assert.deepEqual(first.shown, [hold]);
    assert.deepEqual(second.shown, [null]);
    assert.deepEqual(
      requests.map((request) => request.path),
      ["/v0/management/control"],
    );
    const found = yield* keepWarm.find(ThreadId.make(`${threadId}-1`));
    assert.deepEqual(found?.turn.hold, hold);
    yield* keepWarm.release("root", hold.resetAt);
    assert.deepInclude(requests.at(-1), {
      method: "POST",
      path: "/v0/management/control/keep-warm",
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("treats a router without the control endpoint as holding nothing", () => {
  const { layer } = fixture({ status: 404, body: { error: "not found" } });
  return Effect.gen(function* () {
    const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;
    const stalled = fakeSession("root", 1);
    yield* keepWarm.register(stalled.session);
    yield* TestClock.adjust("30 seconds");
    assert.deepEqual(stalled.shown, [null]);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("runs keep-warm actions against the stalled turn", () => {
  const { requests, layer } = fixture({
    status: 200,
    body: {
      held: [
        {
          session: "root",
          kind: "keep_warm",
          release_at: hold.releaseAt,
          reset_at: hold.resetAt,
        },
      ],
    },
  });
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const keepWarm = yield* ClaudeKeepWarm.ClaudeKeepWarm;
    const stalled = fakeSession("root", 1);
    yield* keepWarm.register(stalled.session);
    const actions = yield* ClaudeKeepWarmActions.make;
    const stalledThread = ThreadId.make(`${threadId}-1`);

    const idle = yield* Effect.flip(actions.run({ threadId: stalledThread, action: "release" }));
    assert.instanceOf(idle, ClaudeKeepWarmActionError);

    yield* TestClock.adjust("30 seconds");
    yield* actions.run({ threadId: stalledThread, action: "pause" });
    assert.deepEqual(stalled.paused, [hold]);

    yield* actions.run({ threadId: stalledThread, action: "compact" });
    assert.deepEqual(
      dispatched.map((command) => command.type),
      ["message.dispatch", "message.dispatch", "run.interrupt"],
    );
    const [compact, resume] = dispatched;
    assert.deepInclude(compact, { text: "/compact" });
    assert.deepInclude(resume, {
      afterCompactionMessageId: MessageId.make("keep-warm-compact:run-1"),
    });
    // Compaction runs on the still-warm account, so it never releases the conversation.
    assert.isFalse(requests.some((request) => request.method === "POST"));

    yield* actions.run({ threadId: stalledThread, action: "release" });
    assert.deepInclude(requests.at(-1), {
      method: "POST",
      path: "/v0/management/control/keep-warm",
      body: { sessions: ["root"], expires_at: hold.resetAt },
    });
    assert.deepEqual(stalled.shown.at(-1), null);
  }).pipe(
    Effect.provide(
      Layer.merge(
        layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return {} as never;
            }),
        }),
      ),
    ),
    Effect.scoped,
  );
});
