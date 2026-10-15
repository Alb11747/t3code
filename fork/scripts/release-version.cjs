const { readFileSync } = require("node:fs");

const { compareVersions, nightlyVersion, releaseChanges } = require("./release-notes.cjs");

// Published fork releases only: a draft is a cancelled publish whose tag the
// next run reuses.
function publishedTags(releases) {
  return releases
    .flat()
    .filter((release) => !release.draft && nightlyVersion(release.tag_name))
    .map((release) => release.tag_name);
}

function newestPublishedTag(releases) {
  return (
    publishedTags(releases).sort((left, right) =>
      compareVersions(nightlyVersion(right), nightlyVersion(left)),
    )[0] ?? null
  );
}

// The next fork version on an upstream nightly. v0.0.46-nightly.20261014.3132
// gives 0.0.46-nightly.20261014.3132.fork when the fork only rebased its
// patches onto it, then .fork.1, .fork.2, ... for each release with new or
// updated fork patches. The count restarts on each upstream nightly. A manual
// sync onto upstream main past a released nightly also takes the next number.
function nextForkVersion(releases, upstreamTag, hasForkChanges, hasUpstreamChanges = false) {
  const upstream = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/.exec(upstreamTag)?.[1];
  if (!upstream) throw new Error(`Invalid upstream nightly tag: ${upstreamTag}`);
  const onUpstream = publishedTags(releases)
    .map((tag) => /^v(.+)\.fork(?:\.(\d+))?$/.exec(tag))
    .filter((match) => match?.[1] === upstream);
  const newest = newestPublishedTag(releases);
  if (!hasForkChanges && !hasUpstreamChanges && onUpstream.length > 0) {
    // Nothing would tell this build apart from the last one on this nightly.
    throw new Error(`No upstream or fork changes since ${newest}; nothing to release.`);
  }
  const version =
    onUpstream.length === 0 && !hasForkChanges
      ? `${upstream}.fork`
      : `${upstream}.fork.${Math.max(0, ...onUpstream.map((match) => Number(match[2] ?? 0))) + 1}`;

  // The Nightly updater installs the feed's newest release even when it is a
  // lower version, so a release on an older upstream nightly would roll every
  // install back. Keep the lineage moving forward.
  if (newest && compareVersions(nightlyVersion(`v${version}`), nightlyVersion(newest)) <= 0) {
    throw new Error(
      `Fork version ${version} does not sort above the newest fork release ${newest}; publishing it would roll installed copies back. Sync onto a newer upstream nightly first.`,
    );
  }
  return version;
}

module.exports = { nextForkVersion };

if (require.main === module) {
  const [releasesFile, upstreamTag, repository, upstreamRef] = process.argv.slice(2);
  if (!releasesFile || !upstreamTag || !repository || !upstreamRef) {
    throw new Error(
      "Usage: node release-version.cjs <releases.json> <upstream-nightly-tag> <owner/repo> <upstream-ref>",
    );
  }
  const releases = JSON.parse(readFileSync(releasesFile, "utf8"));
  const { forkChanges, upstreamChanges } = releaseChanges({
    cwd: process.cwd(),
    previousTag: newestPublishedTag(releases),
    repository,
    upstreamRef,
  });
  const version = nextForkVersion(
    releases,
    upstreamTag,
    forkChanges.length > 0,
    upstreamChanges.length > 0,
  );
  process.stdout.write(`${version}\n`);
}
