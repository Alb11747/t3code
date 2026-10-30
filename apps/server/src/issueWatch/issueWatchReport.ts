import type { OrchestrationV2Notification } from "@t3tools/contracts";

/** Bounds consecutive wakes so a bot replying to the agent cannot loop forever, as PR watches do. */
export const ISSUE_WATCH_WAKE_LIMIT = 10;
const LISTED_COMMENTS = 10;
const SNIPPET_LENGTH = 200;

export interface IssueRef {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

export interface IssueComment {
  readonly id: number;
  readonly author: string | null;
  readonly body: string;
  readonly url: string;
  readonly updatedAt: string;
}

export interface IssueWatchCursor {
  /** Comments updated after this host timestamp are news. */
  readonly commentsThrough: string;
  /** Comments stamped exactly at `commentsThrough` that were already told; hosts stamp to the second. */
  readonly commentIds: ReadonlyArray<number>;
  readonly wakes: number;
}

export type ParsedIssueUrl =
  | { readonly kind: "issue"; readonly issue: IssueRef; readonly url: string }
  | { readonly kind: "pull-request" }
  | { readonly kind: "invalid" };

export function parseIssueUrl(input: string): ParsedIssueUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "invalid" };
  }
  const match = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || match === null) return { kind: "invalid" };
  if (match[3] === "pull") return { kind: "pull-request" };
  const host = url.hostname.toLowerCase();
  const repository = `${match[1]}/${match[2]}`;
  const number = Number(match[4]);
  if (number < 1) return { kind: "invalid" };
  return {
    kind: "issue",
    issue: { host, repository, number },
    url: `https://${host}/${repository}/issues/${number}`,
  };
}

/** Comments after the cursor written by someone other than `viewer`, and the cursor past them. */
export function advanceIssueWatch(
  cursor: IssueWatchCursor,
  comments: ReadonlyArray<IssueComment>,
  viewer: string | null,
): { readonly fresh: ReadonlyArray<IssueComment>; readonly next: IssueWatchCursor } {
  const through = Date.parse(cursor.commentsThrough);
  const unseen = comments.filter((comment) => {
    const at = Date.parse(comment.updatedAt);
    return at > through || (at === through && !cursor.commentIds.includes(comment.id));
  });
  // The cursor passes the viewer's own comments too, so they are never reconsidered.
  const latest = Math.max(through, ...unseen.map((comment) => Date.parse(comment.updatedAt)));
  const atLatest = unseen.filter((comment) => Date.parse(comment.updatedAt) === latest);
  const own = viewer?.toLowerCase();
  const fresh = unseen.filter(
    (comment) => own === undefined || comment.author?.toLowerCase() !== own,
  );
  const viewerReplied =
    own !== undefined && unseen.some((comment) => comment.author?.toLowerCase() === own);
  return {
    fresh,
    next: {
      commentsThrough: latest === through ? cursor.commentsThrough : atLatest[0]!.updatedAt,
      commentIds: [
        ...(latest === through ? cursor.commentIds : []),
        ...atLatest.map((comment) => comment.id),
      ],
      wakes: fresh.length === 0 ? 0 : (viewerReplied ? 0 : cursor.wakes) + 1,
    },
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

export interface IssueWatchWake {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}

export function issueWatchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly fresh: ReadonlyArray<IssueComment>;
  /** The host's closing reason when the issue closed, which ends the watch. */
  readonly closed: { readonly reason: string | null } | null;
  readonly exhausted: boolean;
}): IssueWatchWake {
  const { fresh, closed } = input;
  const lines = [
    `Update on issue #${input.number} (${input.url}), which T3 Code is watching for you:`,
  ];
  const summary: Array<string> = [];
  if (fresh.length > 0) {
    lines.push(`- ${fresh.length} new ${fresh.length === 1 ? "comment" : "comments"}:`);
    for (const comment of fresh.slice(0, LISTED_COMMENTS)) {
      lines.push(`  - ${comment.author ?? "someone"}: "${snippet(comment.body)}" ${comment.url}`);
    }
    if (fresh.length > LISTED_COMMENTS) {
      lines.push(`  - and ${fresh.length - LISTED_COMMENTS} more`);
    }
    summary.push("new comments");
  }
  if (closed !== null) {
    lines.push(`- The issue was closed${closed.reason === null ? "" : ` as ${closed.reason}`}.`);
    summary.push("closed");
  }
  lines.push("");
  if (closed !== null) {
    lines.push("T3 Code stopped watching it. Call watch_issue if it reopens.");
    summary.push("stopped watching");
  } else if (input.exhausted) {
    lines.push(
      `T3 Code stopped watching after ${ISSUE_WATCH_WAKE_LIMIT} updates in a row. Call watch_issue to watch it again.`,
    );
    summary.push("stopped watching");
  } else {
    lines.push(
      "Look into each comment and act on it as your task requires. The watch stays on, so do not call watch_issue again. End your turn when you are done, and T3 Code wakes you on the next comment. When you hand the work back to the user, call unwatch_issue first.",
    );
  }
  return {
    text: lines.join("\n"),
    notification: {
      source: { kind: "monitor" },
      outcome: "updated",
      summary: `Issue #${input.number}: ${summary.join(", ")}`,
    },
  };
}
