import { describe, expect, it } from "@effect/vitest";

import { advanceIssueWatch, type IssueComment, parseIssueUrl } from "./issueWatchReport.ts";

const comment = (id: number, updatedAt: string, author: string | null = "alice"): IssueComment => ({
  id,
  author,
  body: `comment ${id}`,
  url: `https://github.com/acme/app/issues/1#issuecomment-${id}`,
  updatedAt,
});

describe("parseIssueUrl", () => {
  it("normalizes issue URLs and rejects pull requests and other pages", () => {
    expect(parseIssueUrl("https://GitHub.com/acme/app/issues/12/?x=1#issuecomment-3")).toEqual({
      kind: "issue",
      issue: { host: "github.com", repository: "acme/app", number: 12 },
      url: "https://github.com/acme/app/issues/12",
    });
    expect(parseIssueUrl("https://github.com/acme/app/pull/12").kind).toBe("pull-request");
    expect(parseIssueUrl("https://github.com/acme/app/issues").kind).toBe("invalid");
    expect(parseIssueUrl("http://github.com/acme/app/issues/12").kind).toBe("invalid");
    expect(parseIssueUrl("acme/app#12").kind).toBe("invalid");
  });
});

describe("advanceIssueWatch", () => {
  const start = { commentsThrough: "2026-10-01T00:00:00Z", commentIds: [1], wakes: 0 };

  it("tells only unseen comments by others and moves the cursor past all of them", () => {
    const { fresh, next } = advanceIssueWatch(
      start,
      [
        comment(1, "2026-10-01T00:00:00Z"),
        comment(2, "2026-10-01T00:00:00Z"),
        comment(3, "2026-10-01T00:05:00Z", "Agent-Account"),
        comment(4, "2026-10-01T00:05:00Z"),
      ],
      "agent-account",
    );
    expect(fresh.map((item) => item.id)).toEqual([2, 4]);
    expect(next).toEqual({ commentsThrough: "2026-10-01T00:05:00Z", commentIds: [3, 4], wakes: 1 });
  });

  it("does not count a wake when only the viewer commented", () => {
    const { fresh, next } = advanceIssueWatch(
      start,
      [comment(5, "2026-10-01T00:01:00Z", "me")],
      "me",
    );
    expect(fresh).toEqual([]);
    expect(next).toEqual({ commentsThrough: "2026-10-01T00:01:00Z", commentIds: [5], wakes: 0 });
  });
});
