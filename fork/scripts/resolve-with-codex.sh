#!/usr/bin/env bash
# Resolve a rebase stopped by sync-upstream.sh with Codex, one conflicting
# commit at a time. Codex only edits files; this script stages them and drives
# the rebase, so Codex never needs to write to .git.
#
#   fork/scripts/resolve-with-codex.sh <prompt-file>
#
# Pass a prompt file copied outside the worktree (fork/prompts/resolve-conflict.md
# before the sync started): mid-rebase, the checkout may not contain it.
# Set CODEX_MODEL to pick a model, and CODEX_SUMMARY_FILE to collect Codex's
# per-commit summaries for review. Exits non-zero if conflicts remain.
set -euo pipefail

prompt_file=$1
max_rounds=${CODEX_MAX_ROUNDS:-15}
model_args=()
if [[ -n "${CODEX_MODEL:-}" ]]; then model_args=(--model "$CODEX_MODEL"); fi
summary=
trap '[[ -z "$summary" ]] || rm -f "$summary"' EXIT

rebase_in_progress() {
  [[ -d "$(git rev-parse --git-path rebase-merge)" ]]
}

for ((round = 1; round <= max_rounds; round++)); do
  rebase_in_progress || break

  mapfile -d '' -t conflicted < <(git diff --name-only --diff-filter=U -z)
  if ((${#conflicted[@]})); then
    stopped=$(git rev-parse REBASE_HEAD)
    echo "Round $round: asking Codex to resolve $(git log -1 --format='%h %s' "$stopped")"
    prompt="$(cat "$prompt_file")

## Stopped commit

$(git log -1 --format='%H%nAuthor: %an%n%n%B' "$stopped")

## Conflicted files

$(printf -- '- %s\n' "${conflicted[@]}")"
    summary=$(mktemp)
    codex exec --sandbox workspace-write "${model_args[@]}" --output-last-message "$summary" "$prompt"
    if [[ -n "${CODEX_SUMMARY_FILE:-}" ]]; then
      printf '### %s\n\n%s\n\n' "$(git log -1 --format='%h %s' "$stopped")" "$(cat "$summary")" >>"$CODEX_SUMMARY_FILE"
    fi
    rm -f "$summary"
    summary=

    if git grep -nE '^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)( |$)' -- "${conflicted[@]}"; then
      echo "Conflict markers remain after Codex ran." >&2
      exit 1
    fi
    git add -- "${conflicted[@]}"
  fi

  # A patch that upstream made redundant resolves to no change; skip it.
  if git diff --cached --quiet; then
    git rebase --skip || { rebase_in_progress || exit 1; }
  else
    GIT_EDITOR=true git rebase --continue || { rebase_in_progress || exit 1; }
  fi
done

if rebase_in_progress; then
  echo "Rebase still stopped after $max_rounds rounds." >&2
  exit 1
fi
