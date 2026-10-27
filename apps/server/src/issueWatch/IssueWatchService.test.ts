import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as IssueWatchService from "./IssueWatchService.ts";

const THREAD_ID = ThreadId.make("thread-1");
const ISSUE = {
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
};

interface FakeGitHub {
  issue: {
    state: string;
    state_reason?: string | null;
    updated_at: string;
    pull_request?: object;
  };
  comments: Array<{ id: number; updated_at: string; login: string; body: string }>;
  settledAt: string | null;
  dispatchFailures: number;
}

const setup = () => {
  const github: FakeGitHub = {
    issue: { state: "open", updated_at: "2026-10-01T00:00:00Z" },
    comments: [{ id: 1, updated_at: "2026-09-30T00:00:00Z", login: "alice", body: "old" }],
    settledAt: null,
    dispatchFailures: 0,
  };
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const respond = (apiPath: string) => {
    if (apiPath === "user") return { login: "agent" };
    const [route, query = ""] = apiPath.split("?");
    if (route === "repos/acme/app/issues/7") return github.issue;
    const params = new URLSearchParams(query);
    const since = Date.parse(params.get("since")!);
    const perPage = Number(params.get("per_page"));
    const page = Number(params.get("page"));
    return github.comments
      .filter((comment) => Date.parse(comment.updated_at) >= since)
      .toSorted((left, right) => left.id - right.id)
      .slice((page - 1) * perPage, page * perPage)
      .map((comment) => ({
        id: comment.id,
        html_url: `${ISSUE.url}#issuecomment-${comment.id}`,
        updated_at: comment.updated_at,
        body: comment.body,
        user: { login: comment.login },
      }));
  };
  const layer = Layer.mergeAll(
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) =>
        Effect.succeed({
          exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
          stdout: JSON.stringify(respond(input.args.at(-1)!)),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        github.dispatchFailures-- > 0
          ? Effect.die(new Error("orchestrator unavailable"))
          : Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length, storedEvents: [] };
            }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          v2PullRequestThread({
            id: threadId,
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            latestUserMessageAt: null,
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            archivedAt: null,
            settledOverride: null,
            settledAt: github.settledAt,
          }),
        ),
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-issue-watch-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  // Holds the background sweep so each test runs sweeps itself.
  const service = IssueWatchService.make.pipe(
    Effect.provideService(ServerActivation, Effect.never),
  );
  const wakes = () =>
    dispatched.flatMap((command) => (command.type === "message.dispatch" ? [command.text] : []));
  return { github, dispatched, wakes, layer, service };
};

describe("IssueWatchService", () => {
  it.effect("wakes on comments from others after the watch starts, once each", () => {
    const { github, wakes, layer, service } = setup();
    return Effect.gen(function* () {
      const watches = yield* service;
      expect(yield* watches.watch(THREAD_ID, ISSUE)).toMatchObject({
        watching: true,
        wasWatching: false,
      });
      expect((yield* watches.watch(THREAD_ID, ISSUE)).wasWatching).toBe(true);

      yield* watches.sweep;
      expect(wakes()).toEqual([]);

      github.issue = { state: "open", updated_at: "2026-10-01T00:10:00Z" };
      github.comments.push(
        { id: 2, updated_at: "2026-10-01T00:05:00Z", login: "agent", body: "my reply" },
        { id: 3, updated_at: "2026-10-01T00:10:00Z", login: "bob", body: "Still broken on 1.2" },
      );
      yield* watches.sweep;
      yield* watches.sweep;
      expect(wakes()).toHaveLength(1);
      expect(wakes()[0]).toContain('bob: "Still broken on 1.2"');
      expect(wakes()[0]).not.toContain("my reply");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("stops after unwatch, and keeps watches across restarts", () => {
    const { github, wakes, layer, service } = setup();
    return Effect.gen(function* () {
      yield* Effect.scoped(Effect.flatMap(service, (watches) => watches.watch(THREAD_ID, ISSUE)));
      const restarted = yield* service;
      github.issue = { state: "open", updated_at: "2026-10-01T00:10:00Z" };
      github.comments.push({ id: 2, updated_at: "2026-10-01T00:10:00Z", login: "bob", body: "hi" });
      yield* restarted.sweep;
      expect(wakes()).toHaveLength(1);

      expect((yield* restarted.unwatch(THREAD_ID, ISSUE)).wasWatching).toBe(true);
      github.issue = { state: "open", updated_at: "2026-10-01T00:20:00Z" };
      github.comments.push({ id: 3, updated_at: "2026-10-01T00:20:00Z", login: "bob", body: "?" });
      yield* restarted.sweep;
      expect(wakes()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("ends the watch with one wake when the issue closes", () => {
    const { github, wakes, layer, service } = setup();
    return Effect.gen(function* () {
      const watches = yield* service;
      yield* watches.watch(THREAD_ID, ISSUE);
      github.issue = {
        state: "closed",
        state_reason: "completed",
        updated_at: "2026-10-02T00:00:00Z",
      };
      yield* watches.sweep;
      yield* watches.sweep;
      expect(wakes()).toHaveLength(1);
      expect(wakes()[0]).toContain("The issue was closed as completed.");
      expect((yield* watches.unwatch(THREAD_ID, ISSUE)).wasWatching).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("ends the watch silently when its thread settles", () => {
    const { github, wakes, layer, service } = setup();
    return Effect.gen(function* () {
      const watches = yield* service;
      yield* watches.watch(THREAD_ID, ISSUE);
      github.settledAt = "2026-10-02T00:00:00.000Z";
      github.issue = { state: "open", updated_at: "2026-10-02T00:00:00Z" };
      github.comments.push({ id: 2, updated_at: "2026-10-02T00:00:00Z", login: "bob", body: "hi" });
      yield* watches.sweep;
      expect(wakes()).toEqual([]);
      expect((yield* watches.unwatch(THREAD_ID, ISSUE)).wasWatching).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("reads every page and same-second comments before moving the cursor", () => {
    const { github, wakes, layer, service } = setup();
    return Effect.gen(function* () {
      const watches = yield* service;
      yield* watches.watch(THREAD_ID, ISSUE);
      // Same second as the issue's timestamp when the watch started, which stays unchanged.
      github.comments.push({ id: 2, updated_at: "2026-10-01T00:00:00Z", login: "bob", body: "a" });
      yield* watches.sweep;
      expect(wakes()).toHaveLength(1);

      github.issue = { state: "open", updated_at: "2026-10-01T01:00:00Z" };
      for (let id = 3; id <= 122; id++) {
        github.comments.push({ id, updated_at: "2026-10-01T00:30:00Z", login: "bob", body: "b" });
      }
      // GitHub orders by ID, so an old comment edited later lands on the first page.
      github.comments[0] = { ...github.comments[0]!, updated_at: "2026-10-01T00:59:00Z" };
      yield* watches.sweep;
      yield* watches.sweep;
      expect(wakes()).toHaveLength(2);
      expect(wakes()[1]).toContain("121 new comments");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps an update until its wake is delivered", () => {
    const { github, wakes, layer, service } = setup();
    return Effect.gen(function* () {
      const watches = yield* service;
      yield* watches.watch(THREAD_ID, ISSUE);
      github.issue = { state: "closed", state_reason: null, updated_at: "2026-10-02T00:00:00Z" };
      github.dispatchFailures = 1;
      yield* watches.sweep;
      expect(wakes()).toEqual([]);
      yield* watches.sweep;
      expect(wakes()).toHaveLength(1);
      expect(wakes()[0]).toContain("The issue was closed.");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("refuses closed issues and pull requests", () => {
    const { github, layer, service } = setup();
    return Effect.gen(function* () {
      const watches = yield* service;
      github.issue = { ...github.issue, pull_request: {} };
      const pullRequest = yield* Effect.flip(watches.watch(THREAD_ID, ISSUE));
      expect(pullRequest.detail).toContain("watch_pull_request");
      github.issue = { state: "closed", updated_at: "2026-10-01T00:00:00Z" };
      const closed = yield* Effect.flip(watches.watch(THREAD_ID, ISSUE));
      expect(closed.detail).toBe("Issue #7 is closed.");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
