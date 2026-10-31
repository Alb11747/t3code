const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const { compareVersions, nightlyVersion } = require("./release-notes.cjs");

function releaseAssets(directory, version) {
  const files = readdirSync(directory).filter(
    (name) => /\.(AppImage|deb|exe|blockmap|yml|tar\.gz|zip)$/.test(name) || name === "SHA256SUMS",
  );
  const required = [
    `T3-Code-${version}-x86_64.AppImage`,
    `T3-Code-${version}-amd64.deb`,
    `T3-Code-${version}-x64.exe`,
    `T3-Code-${version}-x64.exe.blockmap`,
    "nightly.yml",
    "nightly-linux.yml",
    "SHA256SUMS",
    `t3-${version}-linux-x64.tar.gz`,
    `t3-${version}-win32-x64.zip`,
  ];
  for (const name of required) {
    if (!files.includes(name)) throw new Error(`Missing release asset: ${name}`);
  }
  return files.map((name) => {
    const file = path.join(directory, name);
    const size = statSync(file).size;
    if (!size) throw new Error(`Empty release asset: ${name}`);
    return {
      name,
      file,
      size,
      digest: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
    };
  });
}

function verifyUploadedAssets(expected, actual) {
  if (
    actual.length !== expected.length ||
    expected.some(
      (file) =>
        !actual.some(
          (asset) =>
            asset.name === file.name &&
            asset.state === "uploaded" &&
            asset.size === file.size &&
            asset.digest === file.digest,
        ),
    )
  ) {
    throw new Error(
      "Uploaded assets do not match the complete local inventory; leaving the release as a draft.",
    );
  }
}

function publish({
  gh,
  repository,
  tag,
  sha,
  name,
  directory = "release-assets",
  notes = "release-notes.md",
}) {
  const version = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\.fork(?:\.\d+)?)$/.exec(tag)?.[1];
  if (!version || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid fork release tag or source SHA.");
  const files = releaseAssets(directory, version);
  const api = (...args) => JSON.parse(gh("api", ...args));
  function verifySource() {
    const main = api(`repos/${repository}/commits/main`).sha;
    if (main !== sha) {
      const diff = api(`repos/${repository}/compare/${sha}...${main}`);
      if (
        diff.status !== "ahead" ||
        diff.files.length >= 300 ||
        diff.files.some((file) => !/^fork\/[^/]+\.md$/.test(file.filename))
      ) {
        throw new Error(
          "Main changed during the build; rebuild the current source instead of publishing stale code.",
        );
      }
    }
  }
  verifySource();
  const releases = api("--paginate", "--slurp", `repos/${repository}/releases?per_page=100`).flat();
  if (releases.some((release) => release.tag_name === tag)) {
    throw new Error(
      "Release already exists. Inspect any cancelled draft before deleting it and retrying; never overwrite a published release.",
    );
  }
  function verifyLineage() {
    const published = api(
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ).flat();
    if (
      published.some(
        (release) =>
          !release.draft &&
          nightlyVersion(release.tag_name) &&
          compareVersions(nightlyVersion(tag), nightlyVersion(release.tag_name)) <= 0,
      )
    ) {
      throw new Error(
        "A newer or identical version is already published; refusing to roll installed clients back.",
      );
    }
    const refs = api(`repos/${repository}/git/matching-refs/tags/${tag}`);
    if (
      refs.some((ref) => ref.ref === `refs/tags/${tag}`) &&
      api(`repos/${repository}/commits/${tag}`).sha !== sha
    ) {
      throw new Error("Release tag points at a different commit.");
    }
  }
  verifyLineage();
  // Creating the draft claims this version atomically, even across repositories.
  // A cancelled upload keeps that claim instead of exposing an incomplete feed.
  const release = api(
    "--method",
    "POST",
    `repos/${repository}/releases`,
    "-f",
    `tag_name=${tag}`,
    "-f",
    `target_commitish=${sha}`,
    "-f",
    `name=${name}`,
    "-f",
    `body=${readFileSync(notes, "utf8")}`,
    "-F",
    "draft=true",
    "-F",
    "prerelease=true",
    "-f",
    "make_latest=false",
  );
  gh("release", "upload", tag, ...files.map((file) => file.file), "--repo", repository);
  const assets = api(
    "--paginate",
    "--slurp",
    `repos/${repository}/releases/${release.id}/assets?per_page=100`,
  ).flat();
  verifyUploadedAssets(files, assets);
  // New tags materialize when the draft is published. Existing tags must still
  // identify this source, and a concurrent release must not roll the feed back.
  verifyLineage();
  verifySource();
  gh(
    "release",
    "edit",
    tag,
    "--draft=false",
    "--prerelease",
    "--latest=false",
    "--repo",
    repository,
  );
  console.log(`Published ${repository} ${tag} from ${sha} with ${files.length} verified assets.`);
}

module.exports = { publish, releaseAssets, verifyUploadedAssets };

if (require.main === module) {
  if (!process.env.GH_TOKEN)
    throw new Error("Missing release credential (Labs requires FORK_RELEASE_TOKEN).");
  publish({
    gh: (...args) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    repository: process.env.GH_REPO,
    tag: process.env.RELEASE_TAG,
    sha: process.env.RELEASE_SHA,
    name: process.env.RELEASE_NAME,
  });
}
