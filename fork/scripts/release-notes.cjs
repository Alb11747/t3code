const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

function nightlyVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function previousReleaseTag(releases, currentTag) {
  const currentVersion = nightlyVersion(currentTag);
  if (!currentVersion) throw new Error(`Invalid fork nightly tag: ${currentTag}`);
  const candidates = releases.flat().filter((release) => {
    const version = nightlyVersion(release.tag_name);
    return (
      !release.draft &&
      release.published_at &&
      version &&
      compareVersions(version, currentVersion) < 0
    );
  });
  candidates.sort((left, right) =>
    compareVersions(nightlyVersion(right.tag_name), nightlyVersion(left.tag_name)),
  );
  return candidates[0]?.tag_name ?? null;
}

function buildReleaseNotes({ cwd, releases, currentTag, repository, upstreamRef }) {
  const gitOutput = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
    });
  const git = (...args) => gitOutput(...args).trim();
  function patchSignature(sha) {
    // Compare only the actual edit, retaining whitespace that can change code
    // or string behavior. Surrounding context and hunk positions often change
    // during a rebase; git cherry's patch IDs also ignore meaningful whitespace.
    const patch = gitOutput(
      "show",
      "--format=",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--unified=0",
      sha,
    )
      .split("\n")
      .filter((line) => !line.startsWith("index ") && !line.startsWith("@@"))
      .join("\n");
    return createHash("sha256").update(patch).digest("hex");
  }

  function hunks(from, to, file) {
    const diff = gitOutput(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=0",
      from,
      to,
      "--",
      file,
    );
    return Array.from(diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm), (match) => ({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    }));
  }

  function sameLocations(previous, current) {
    // Identical edits can target different functions. Map their old-file line
    // positions through changes between the parents, so a moved edit is new
    // while an upstream insertion shifting the same edit is still carried.
    const files = gitOutput(
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "-r",
      "-z",
      current,
    )
      .split("\0")
      .filter(Boolean);
    return files.every((file) => {
      const oldHunks = hunks(`${previous}^`, previous, file);
      const newHunks = hunks(`${current}^`, current, file);
      if (oldHunks.length !== newHunks.length) return false;
      const parentChanges = hunks(`${previous}^`, `${current}^`, file);
      return oldHunks.every((hunk, index) => {
        const boundary = hunk.oldStart + (hunk.oldCount === 0 ? 1 : 0);
        let shift = 0;
        for (const change of parentChanges) {
          const start = change.oldStart + (change.oldCount === 0 ? 1 : 0);
          const end = change.oldStart + (change.oldCount === 0 ? 1 : change.oldCount);
          if (end <= boundary) {
            shift += change.newCount - change.oldCount;
          } else {
            if (start < boundary) return false;
            break;
          }
        }
        return hunk.oldStart + shift === newHunks[index].oldStart;
      });
    });
  }
  const head = git("rev-parse", "HEAD");
  const base = git("merge-base", head, upstreamRef);
  const previousTag = previousReleaseTag(releases, currentTag);
  const lines = [];
  let previousBase = null;
  let previousPatches = null;

  if (previousTag) {
    const previousHead = git("rev-parse", `${previousTag}^{commit}`);
    previousBase = git("merge-base", previousHead, upstreamRef);
    // A rewind needs explicit release notes; silently listing a forward range
    // would describe changes that were actually removed.
    git("merge-base", "--is-ancestor", previousBase, base);
    lines.push(
      `### Since [${previousTag}](https://github.com/${repository}/releases/tag/${previousTag})`,
    );
    previousPatches = new Map();
    for (const sha of git("rev-list", `${previousBase}..${previousHead}`)
      .split("\n")
      .filter(Boolean)) {
      const signature = patchSignature(sha);
      const matches = previousPatches.get(signature) ?? [];
      matches.push(sha);
      previousPatches.set(signature, matches);
    }
  } else {
    lines.push("### Initial fork release");
  }
  lines.push(
    `### Built from upstream [${base.slice(0, 12)}](https://github.com/pingdotgg/t3code/commit/${base})`,
    "",
  );

  function changes(from, to, source, commitRepository, include = () => true) {
    const commits = git("log", "--reverse", "--format=%H%x09%s", `${from}..${to}`);
    if (!commits) return [];
    return commits.split("\n").flatMap((line) => {
      const separator = line.indexOf("\t");
      const sha = line.slice(0, separator);
      const subject = line.slice(separator + 1);
      return include(sha)
        ? [
            `- ${source}: ${subject} ([${sha.slice(0, 9)}](https://github.com/${commitRepository}/commit/${sha}))`,
          ]
        : [];
    });
  }

  const upstreamChanges = previousBase
    ? changes(previousBase, base, "Upstream", "pingdotgg/t3code")
    : [];
  const forkChanges = changes(base, head, "Fork", repository, (sha) => {
    if (previousPatches === null) return true;
    const matches = previousPatches.get(patchSignature(sha)) ?? [];
    return !matches.some((previous) => previous === sha || sameLocations(previous, sha));
  });
  if (upstreamChanges.length) lines.push("### Upstream changes", ...upstreamChanges, "");
  // The desktop popover keeps the last eight items and shows them newest first.
  // Put fork changes last so they remain visible when upstream has a busy cut.
  if (forkChanges.length) lines.push("### New or updated fork patches", ...forkChanges, "");
  if (!upstreamChanges.length && !forkChanges.length) {
    lines.push("No new upstream changes or fork patches since the previous release.", "");
  }
  // A heading keeps this inventory link out of the popover's change count.
  lines.push(
    `### [All carried fork patches](https://github.com/${repository}/blob/${head}/fork/CHANGES.md)`,
  );
  return `${lines.join("\n")}\n`;
}

module.exports = { buildReleaseNotes, previousReleaseTag };

if (require.main === module) {
  const [releasesFile, currentTag, repository, upstreamRef] = process.argv.slice(2);
  if (!releasesFile || !currentTag || !repository || !upstreamRef) {
    throw new Error(
      "Usage: node release-notes.cjs <releases.json> <current-tag> <owner/repo> <upstream-ref>",
    );
  }
  process.stdout.write(
    buildReleaseNotes({
      cwd: process.cwd(),
      releases: JSON.parse(readFileSync(releasesFile, "utf8")),
      currentTag,
      repository,
      upstreamRef,
    }),
  );
}
