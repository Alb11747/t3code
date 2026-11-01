const { readFileSync } = require("node:fs");

function isReleaseRelevantPath(filename) {
  return ![".github/workflows/", ".github/actions/", "fork/"].some((prefix) =>
    filename.startsWith(prefix),
  );
}

function hasReleaseChanges(files) {
  return files.some(
    (file) =>
      isReleaseRelevantPath(file.filename) ||
      (file.previous_filename && isReleaseRelevantPath(file.previous_filename)),
  );
}

module.exports = { hasReleaseChanges };

if (require.main === module) {
  const files = readFileSync(process.argv[2], "utf8")
    .split("\0")
    .filter(Boolean)
    .map((filename) => ({ filename }));
  console.log(hasReleaseChanges(files));
}
