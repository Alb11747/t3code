#!/usr/bin/env bash
# Merge upstream into the fork's current branch (normally main).
#
#   fork/scripts/sync-upstream.sh                        merge the latest upstream main
#   fork/scripts/sync-upstream.sh --onto <upstream_sha>  merge a pinned upstream commit
#
# Fork commits are never rewritten. Patches whose `Upstream-PR:` trailer points
# at an upstream PR merged into the new upstream commit are reverted first,
# with their fork/CHANGES.md entries, so the merge takes upstream's version.
# Requires `gh`.
#
# Exit codes: 0 = up to date or merged; 2 = a revert or the merge stopped on a
# conflict. Resolve the files, `git add` them, `git commit --no-edit`, then run
# the same command again: it continues where it stopped.
set -euo pipefail

upstream_repo=${UPSTREAM_REPO:-pingdotgg/t3code}
upstream_branch=${UPSTREAM_BRANCH:-main}
changes=fork/CHANGES.md

output() {
  echo "$1=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi
}

# A failed revert or merge is a conflict only when it left unmerged paths;
# anything else (a fetch or hook failure) is an error, not work for a resolver.
stopped() {
  if [[ -n $(git ls-files --unmerged) ]]; then
    output status conflict
    exit 2
  fi
  exit 1
}

onto=
if [[ $# == 2 && $1 == --onto && $2 =~ ^[0-9a-f]{40}$ ]]; then
  onto=$2
elif [[ $# != 0 ]]; then
  echo "Usage: $0 [--onto <full upstream SHA>]" >&2
  exit 1
fi

for head in MERGE_HEAD REVERT_HEAD CHERRY_PICK_HEAD REBASE_HEAD; do
  if git rev-parse -q --verify "$head" >/dev/null; then
    echo "$head exists; commit or abort that operation first." >&2
    exit 1
  fi
done
# Reverts and the merge commit whatever is staged, so start from a clean tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "The checkout must be clean before syncing." >&2
  exit 1
fi

git fetch --no-tags --quiet "https://github.com/${upstream_repo}.git" "$upstream_branch"
upstream=$(git rev-parse FETCH_HEAD)
if [[ -n "$onto" ]]; then
  if ! git merge-base --is-ancestor "$onto" "$upstream"; then
    echo "The pinned SHA is not an ancestor of fetched upstream main." >&2
    exit 1
  fi
  upstream=$onto
fi
# A stable name for later steps (workflows, resolvers) that need the new base.
git update-ref refs/fork/upstream "$upstream"
output upstream_sha "$upstream"

if git merge-base --is-ancestor "$upstream" HEAD; then
  output status current
  exit 0
fi

# Fork commits not in upstream, newest first, minus those already reverted.
# Several commits can carry one PR (the patch and later review follow-ups);
# reverting newest first keeps each revert applying to its own lines.
reverted=$(git log --format=%B HEAD --not "$upstream" | grep -oE '^This reverts commit [0-9a-f]{40}' | cut -d' ' -f4 || true)
# A `Related-PR:` trailer on any fork commit keeps that PR's patches, such as
# a copy kept after a maintainer took the PR over.
kept=$(git log --format='%(trailers:key=Related-PR,valueonly)' HEAD --not "$upstream" | grep -oE '/pull/[0-9]+' | cut -d/ -f3 || true)
retire=()
declare -A merged=()
while read -r sha; do
  grep -qx "$sha" <<<"$reverted" && continue
  pr=$(git log -1 --format='%(trailers:key=Upstream-PR,valueonly)' "$sha" | grep -oE '/pull/[0-9]+' | head -1 | cut -d/ -f3 || true)
  [[ -n "$pr" ]] || continue
  grep -qx "$pr" <<<"$kept" && continue
  if [[ -z ${merged[$pr]+set} ]]; then
    # A PR merged after the pinned nightly is not in the new base yet, so the
    # patch is retired only once its merge commit is part of $upstream.
    merge=$(gh pr view "$pr" --repo "$upstream_repo" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
    if [[ -n "$merge" && ! "$merge" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Upstream PR #$pr is merged but has no merge commit SHA: $merge" >&2
      exit 1
    fi
    merged[$pr]=false
    if [[ -n "$merge" ]] && git merge-base --is-ancestor "$merge" "$upstream"; then merged[$pr]=true; fi
  fi
  if [[ ${merged[$pr]} == true ]]; then retire+=("$sha $pr"); fi
done < <(git rev-list --no-merges HEAD --not "$upstream")

for entry in "${retire[@]}"; do
  read -r sha pr <<<"$entry"
  subject=$(git log -1 --format=%s "$sha")
  echo "Reverting $subject: upstream PR #$pr merged."
  if ! git revert --no-commit "$sha"; then
    # REVERT_HEAD marks a revert stopped on conflicts; without it, it failed.
    git rev-parse -q --verify REVERT_HEAD >/dev/null || exit 1
  fi
  # The change list is not reverted with the patch: older commits for the same
  # PR edit its entry too, and undoing those edits one by one conflicts.
  # Keep the current list (or its absence) and just delete the PR's entry.
  if git cat-file -e "HEAD:$changes" 2>/dev/null; then
    git checkout -q HEAD -- "$changes"
    sed -i "\#/pull/${pr}\b#d" "$changes"
    git add -- "$changes"
  else
    git rm -q -f --ignore-unmatch -- "$changes"
  fi
  # Restoring the list may have resolved the only conflict.
  [[ -z $(git ls-files --unmerged) ]] || stopped
  # The "This reverts commit" line is how later runs recognize the revert;
  # git's own message for a stopped revert has it too.
  git commit -q --allow-empty -m "Revert \"$subject\"" -m "Upstream PR #$pr merged; sync takes upstream's version." -m "This reverts commit $sha."
done

git merge -q --no-ff -m "chore(fork): merge upstream ${upstream:0:12}" "$upstream" || stopped
output status synced
