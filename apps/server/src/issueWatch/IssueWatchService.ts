import {
  CommandId,
  MessageId,
  OrchestrationV2IssueWatch,
  type OrchestrationV2ThreadShell,
  ThreadId,
  type VcsError,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  advanceIssueWatch,
  ISSUE_WATCH_WAKE_LIMIT,
  type IssueComment,
  type IssueRef,
  type IssueWatchWake,
  issueWatchMessage,
} from "./issueWatchReport.ts";

/**
 * Fork-only: watches GitHub issues for threads and wakes them through the same monitor
 * message a pull request watch sends. Thread-owned records keep their awaited monitor
 * work and GitHub cursors in the same transaction as each wake.
 */

const SWEEP_MINUTES = 2;
const READ_FAILURE_LIMIT = 8;
const COMMENT_PAGE = 100;

const IssueWatch = Schema.Struct({
  threadId: ThreadId,
  ...OrchestrationV2IssueWatch.fields,
});
type IssueWatch = typeof IssueWatch.Type;

const IssueWatchFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), watches: Schema.Array(IssueWatch) }),
);
const encodeIssueWatchFile = Schema.encodeEffect(IssueWatchFile);

const GitHubIssue = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    state_reason: Schema.optional(Schema.NullOr(Schema.String)),
    updated_at: Schema.String,
    pull_request: Schema.optional(Schema.Unknown),
  }),
);

const GitHubComments = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      html_url: Schema.String,
      updated_at: Schema.String,
      body: Schema.optional(Schema.NullOr(Schema.String)),
      user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    }),
  ),
);

const GitHubUser = Schema.fromJsonString(Schema.Struct({ login: Schema.String }));

export class IssueWatchError extends Schema.TaggedError<IssueWatchError>()("IssueWatchError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface IssueWatchResult extends IssueRef {
  readonly url: string;
  readonly watching: boolean;
  readonly wasWatching: boolean;
}

export class IssueWatchService extends Context.Service<
  IssueWatchService,
  {
    readonly watch: (
      threadId: ThreadId,
      issue: IssueRef & { readonly url: string },
    ) => Effect.Effect<IssueWatchResult, IssueWatchError>;
    readonly unwatch: (
      threadId: ThreadId,
      issue: IssueRef & { readonly url: string },
    ) => Effect.Effect<IssueWatchResult, IssueWatchError>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/issueWatch/IssueWatchService") {}

const sameIssue = (watch: Pick<IssueWatch, "host" | "repository" | "number">, issue: IssueRef) =>
  watch.host === issue.host &&
  watch.repository.toLowerCase() === issue.repository.toLowerCase() &&
  watch.number === issue.number;

const keyOf = (watch: IssueWatch) =>
  `${watch.threadId} ${watch.host}/${watch.repository}#${watch.number} ${watch.startedAt}`;

export const inactive = (thread: OrchestrationV2ThreadShell | null) =>
  thread === null ||
  thread.deletedAt !== null ||
  thread.archivedAt !== null ||
  thread.settledOverride === "settled" ||
  thread.lineage.relationshipToParent === "subagent";

const isRateLimited = (error: VcsError) =>
  error._tag === "VcsProcessExitError" && error.failureKind === "rate-limited";

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const cwd = yield* HostProcess.WorkingDirectory;
  const filePath = path.join(config.stateDir, "issue-watches.json");

  const initial = (yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)))
    ? yield* fs.readFileString(filePath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(IssueWatchFile)),
        Effect.map((file) => file.watches),
        Effect.catchCause((cause) =>
          Effect.logWarning("issue watches could not be read; starting with none", {
            cause,
          }).pipe(Effect.as<ReadonlyArray<IssueWatch> | undefined>(undefined)),
        ),
      )
    : undefined;

  const gh = Effect.fn("IssueWatchService.gh")(function* (
    operation: string,
    host: string,
    apiPath: string,
  ) {
    const output = yield* vcs.run({
      operation: `IssueWatchService.${operation}`,
      command: "gh",
      args: ["api", "--hostname", host, apiPath],
      cwd,
      env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
      notFoundDetail: `GitHub found no ${apiPath} visible to the GitHub CLI's account on ${host}.`,
      // Shares gh's server-wide limit so bursts cannot trip GitHub's secondary rate limit.
      concurrency: { key: "gh", limit: 4 },
    });
    return output.stdout;
  });

  const readIssue = (issue: IssueRef) =>
    gh("readIssue", issue.host, `repos/${issue.repository}/issues/${issue.number}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GitHubIssue)),
    );

  /**
   * Every comment updated at or after `since`. GitHub orders them by ID, not by update time,
   * so the cursor may only advance once all pages are read.
   */
  const readComments = Effect.fn("IssueWatchService.readComments")(function* (
    issue: IssueRef,
    since: string,
  ) {
    const comments: Array<IssueComment> = [];
    for (let page = 1; ; page++) {
      const batch = yield* gh(
        "readComments",
        issue.host,
        `repos/${issue.repository}/issues/${issue.number}/comments?since=${encodeURIComponent(since)}&per_page=${COMMENT_PAGE}&page=${page}`,
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GitHubComments)));
      for (const comment of batch) {
        comments.push({
          id: comment.id,
          author: comment.user?.login ?? null,
          body: comment.body ?? "",
          url: comment.html_url,
          updatedAt: comment.updated_at,
        });
      }
      if (batch.length < COMMENT_PAGE) return comments;
    }
  });

  // gh posts as this account, so its own comments (usually the agent's) never wake the thread.
  const viewers = new Map<string, string>();
  const viewerOf = (host: string) =>
    viewers.has(host)
      ? Effect.succeed(viewers.get(host)!)
      : gh("readViewer", host, "user").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GitHubUser)),
          Effect.map(({ login }) => {
            viewers.set(host, login);
            return login;
          }),
        );

  const findWatch = Effect.fn("IssueWatchService.findWatch")(function* (
    threadId: ThreadId,
    issue: IssueRef,
  ) {
    const thread = yield* projections.getThreadShell(threadId);
    const watch = thread?.issueWatches?.find((watch) => sameIssue(watch, issue));
    return watch === undefined ? undefined : { ...watch, threadId };
  });

  const sync = Effect.fn("IssueWatchService.sync")(function* (
    watch: IssueWatch,
    next: IssueWatch | null,
    startedAt?: string,
    wake?: IssueWatchWake,
  ) {
    const { threadId, ...record } = watch;
    const id = yield* crypto.randomUUIDv4();
    yield* engine.dispatch({
      type: "thread.issue-watch.sync",
      commandId: CommandId.make(`server:issue-watch:${threadId}:${id}`),
      threadId,
      host: watch.host,
      repository: watch.repository,
      number: watch.number,
      ...(startedAt === undefined ? {} : { startedAt }),
      watch:
        next === null
          ? null
          : {
              ...record,
              commentsThrough: next.commentsThrough,
              commentIds: next.commentIds,
              wakes: next.wakes,
            },
      ...(wake === undefined
        ? {}
        : {
            wake: { ...wake, messageId: MessageId.make(`message:issue-watch:${id}`) },
          }),
    });
  });

  const watch: IssueWatchService["Service"]["watch"] = Effect.fn("IssueWatchService.watch")(
    function* (threadId, issue) {
      if (yield* findWatch(threadId, issue)) return { ...issue, watching: true, wasWatching: true };
      const current = yield* readIssue(issue);
      if (current.pull_request !== undefined) {
        return yield* new IssueWatchError({
          detail: `${issue.url} is a pull request. Call watch_pull_request instead.`,
        });
      }
      if (current.state !== "open")
        return yield* new IssueWatchError({ detail: `Issue #${issue.number} is closed.` });
      const boundary = yield* readComments(issue, current.updated_at);
      const added: IssueWatch = {
        threadId,
        ...issue,
        startedAt: DateTime.formatIso(yield* DateTime.now),
        commentsThrough: current.updated_at,
        commentIds: boundary
          .filter((comment) => comment.updatedAt === current.updated_at)
          .map((comment) => comment.id),
        wakes: 0,
      };
      yield* sync(added, added);
      if (!(yield* findWatch(threadId, issue)))
        return yield* new IssueWatchError({ detail: "The issue watch's thread became inactive." });
      return { ...issue, watching: true, wasWatching: false };
    },
    Effect.mapError((cause) =>
      cause._tag === "IssueWatchError"
        ? cause
        : new IssueWatchError({ detail: "Could not start watching the issue.", cause }),
    ),
  );

  const unwatch: IssueWatchService["Service"]["unwatch"] = Effect.fn("IssueWatchService.unwatch")(
    function* (threadId, issue) {
      const current = yield* findWatch(threadId, issue);
      if (current !== undefined) yield* sync(current, null);
      return { ...issue, watching: false, wasWatching: current !== undefined };
    },
    Effect.mapError(
      (cause) => new IssueWatchError({ detail: "Could not stop watching the issue.", cause }),
    ),
  );

  const settle = (watch: IssueWatch, next: IssueWatch | null, wake?: IssueWatchWake) =>
    sync(watch, next, watch.startedAt, wake);

  const readFailures = new Map<string, number>();

  const check = Effect.fn("IssueWatchService.check")(function* (watch: IssueWatch) {
    // Ends with its thread, as a pull request watch does.
    if (inactive(yield* projections.getThreadShell(watch.threadId))) {
      yield* settle(watch, null);
      return;
    }
    const read = yield* Effect.result(
      Effect.gen(function* () {
        const issue = yield* readIssue(watch);
        const viewer = yield* viewerOf(watch.host);
        const comments = yield* readComments(watch, watch.commentsThrough);
        return { issue, viewer, comments };
      }),
    );
    if (read._tag === "Failure") {
      const error = read.failure;
      if (error._tag !== "SchemaError" && isRateLimited(error)) return;
      const failures = (readFailures.get(keyOf(watch)) ?? 0) + 1;
      readFailures.set(keyOf(watch), failures);
      yield* Effect.logWarning("issue watch check failed", { issue: keyOf(watch), error });
      if (failures < READ_FAILURE_LIMIT) return;
      readFailures.delete(keyOf(watch));
      yield* settle(watch, null, {
        text: `T3 Code stopped watching issue #${watch.number} (${watch.url}) because it failed to read it from GitHub ${READ_FAILURE_LIMIT} times in a row. Check it yourself, and call watch_issue to watch it again.`,
        notification: {
          source: { kind: "monitor" },
          outcome: "failed",
          summary: `Issue #${watch.number}: stopped watching, could not read it`,
        },
      });
      return;
    }
    readFailures.delete(keyOf(watch));
    const { issue, viewer, comments } = read.success;
    const advanced = advanceIssueWatch(watch, comments, viewer);
    const closed = issue.state === "open" ? null : { reason: issue.state_reason ?? null };
    const exhausted = closed === null && advanced.next.wakes >= ISSUE_WATCH_WAKE_LIMIT;
    const next: IssueWatch | null =
      closed !== null || exhausted ? null : { ...watch, ...advanced.next };
    const wake =
      advanced.fresh.length > 0 || closed !== null
        ? issueWatchMessage({
            number: watch.number,
            url: watch.url,
            fresh: advanced.fresh,
            closed,
            exhausted,
          })
        : undefined;
    if (
      next !== null &&
      wake === undefined &&
      next.commentsThrough === watch.commentsThrough &&
      next.wakes === watch.wakes &&
      next.commentIds.length === watch.commentIds.length &&
      next.commentIds.every((id, index) => id === watch.commentIds[index])
    )
      return;
    yield* settle(watch, next, wake);
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWithIssueWatches();
    const all = threads.flatMap((thread) =>
      (thread.issueWatches ?? []).map((watch) => ({ ...watch, threadId: thread.id })),
    );
    const present = new Set(all.map(keyOf));
    for (const key of readFailures.keys()) if (!present.has(key)) readFailures.delete(key);
    yield* Effect.forEach(
      all,
      (watch) =>
        check(watch).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("issue watch update failed", { issue: keyOf(watch), cause }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.withSpan("IssueWatchService.sweep"),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("issue watch sweep failed", { cause }),
    ),
  );

  if (initial !== undefined) {
    for (const watch of initial) {
      if (!inactive(yield* projections.getThreadShell(watch.threadId))) yield* sync(watch, watch);
    }
    // Clear only after all imports commit; existing generations win if startup is retried.
    yield* writeFileStringAtomically({
      filePath,
      contents: `${yield* encodeIssueWatchFile({ version: 1, watches: [] })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  }

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`))));

  return { watch, unwatch, sweep } satisfies IssueWatchService["Service"];
});

export const layer = Layer.effect(IssueWatchService, make);
