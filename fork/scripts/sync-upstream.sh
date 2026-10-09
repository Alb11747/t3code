#!/usr/bin/env bash
# Rebase the fork's patch series onto the latest upstream main.
#
#   fork/scripts/sync-upstream.sh           start a sync on the current branch
#   fork/scripts/sync-upstream.sh --onto <upstream_sha>  use a pinned upstream base
#   fork/scripts/sync-upstream.sh --finish  after resolving a stopped rebase
#
# Patches whose `Upstream-PR:` trailer points at a merged upstream PR are
# dropped, and their entries are pruned from fork/CHANGES.md. Requires `gh`.
#
# Exit codes: 0 = up to date or rebased; 2 = the rebase stopped on a conflict.
# Resolve it with the T3 resolver or by hand, finish the
# rebase with `git rebase --continue`, then run this script with --finish.
set -euo pipefail

upstream_repo=${UPSTREAM_REPO:-pingdotgg/t3code}
upstream_branch=${UPSTREAM_BRANCH:-main}
dropped_file=$(git rev-parse --git-path fork-dropped-prs)

output() {
  echo "$1=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi
}

rebase_in_progress() {
  [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]
}

# Remove CHANGES.md entries for dropped PRs. The entries belong to the commit that
# last touched the file, so the edit is squashed into it to keep one docs commit.
finish() {
  if rebase_in_progress; then
    echo "A rebase is still in progress; finish it before running --finish." >&2
    exit 1
  fi
  [[ -s "$dropped_file" ]] || { rm -f "$dropped_file"; output status rebased; return; }

  # The fixup commit and autosquash must not absorb unrelated local edits.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "The checkout must be clean before running --finish." >&2
    exit 1
  fi

  local upstream changes=fork/CHANGES.md
  upstream=$(git rev-parse refs/fork/upstream)
  while read -r pr; do
    sed -i "\#/pull/${pr}\b#d" "$changes"
  done <"$dropped_file"
  if ! git diff --quiet -- "$changes"; then
    local target
    target=$(git log -1 --format=%H "$upstream"..HEAD -- "$changes")
    git add -- "$changes"
    git commit -q --fixup="$target"
    GIT_SEQUENCE_EDITOR=true git rebase -q -i --autosquash "$upstream"
  fi
  rm -f "$dropped_file"
  output status rebased
}

if [[ $# == 1 && $1 == "--finish" ]]; then
  finish
  exit 0
fi

onto=
if [[ $# == 2 && $1 == --onto && $2 =~ ^[0-9a-f]{40}$ ]]; then
  onto=$2
elif [[ $# != 0 ]]; then
  echo "Usage: $0 [--finish | --onto <full upstream SHA>]" >&2
  exit 1
fi

if rebase_in_progress; then
  echo "A rebase is already in progress." >&2
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
# A stable name for later steps (--finish, workflows) that need the new base.
git update-ref refs/fork/upstream "$upstream"
base=$(git merge-base HEAD "$upstream")
output upstream_sha "$upstream"

if [[ "$base" == "$upstream" ]]; then
  output status current
  exit 0
fi

: >"$dropped_file"
# Git runs the sequence editor through the shell, so the edits are quoted here.
sequence_editor="sed -i -e ''"
while read -r sha; do
  pr=$(git log -1 --format='%(trailers:key=Upstream-PR,valueonly)' "$sha" | grep -oE '/pull/[0-9]+' | head -1 | cut -d/ -f3 || true)
  [[ -n "$pr" ]] || continue
  state=$(gh pr view "$pr" --repo "$upstream_repo" --json state --jq .state)
  if [[ "$state" == "MERGED" ]]; then
    echo "Dropping $(git log -1 --format=%s "$sha"): upstream PR #$pr merged."
    echo "$pr" >>"$dropped_file"
    sequence_editor+=" -e 's/^pick $sha /drop $sha /'"
  fi
done < <(git rev-list --reverse "$base"..HEAD)

# core.abbrev=40 puts full hashes in the todo list so the drop edits match.
if ! GIT_SEQUENCE_EDITOR="$sequence_editor" git -c core.abbrev=40 rebase -q -i --onto "$upstream" "$base"; then
  if rebase_in_progress; then
    output status conflict
    exit 2
  fi
  exit 1
fi

finish
