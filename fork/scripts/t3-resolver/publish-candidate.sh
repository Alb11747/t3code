#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 2 && -f $2 ]] || die "Usage: $0 <request_run_id> <summary-file>"
summary_file=$(realpath "$2")
export FORK_RESOLVER_CREDENTIAL_HELPER
FORK_RESOLVER_CREDENTIAL_HELPER=$(realpath "$(dirname "${BASH_SOURCE[0]}")/credential-helper.sh")
load_claim "$1"
cd "$resolver_home/repo"
sync_in_progress && die "Commit the merge or revert, and rerun the sync script, before publishing."
[[ -z $(git status --porcelain --untracked-files=normal) ]] || die "Candidate checkout must be clean (ignored files are allowed)."
git merge-base --is-ancestor "$upstream_sha" HEAD || die "Candidate does not contain the requested upstream SHA."
# Promotion fast-forwards main, so the candidate must build on it.
git merge-base --is-ancestor "$main_sha" HEAD || die "Candidate does not contain the request's fork main."
stopped_sha=$(jq -r .stopped_commit "$ledger")
if [[ $stopped_sha != "$upstream_sha" ]]; then
  retirement=$(git log -1 --format=%H --grep="^This reverts commit $stopped_sha[.]" "$main_sha..HEAD" --not "$upstream_sha")
  if [[ -z $retirement ]]; then
    echo "Compare carry $stopped_sha with the pinned upstream version, reconcile any remaining carry changes and its fork/CHANGES.md entry, and stage the result." >&2
    echo "Record the retirement: git commit -m 'revert(fork): retire upstream carry' -m 'This reverts commit $stopped_sha.'" >&2
    die "Add --allow-empty only if that comparison shows no changes are needed."
  fi
fi
[[ $(remote_main) == "$main_sha" ]] || die "Fork main changed; request is stale."
candidate_sha=$(git rev-parse HEAD)
current=$(git ls-remote "$fork_url" refs/heads/sync/candidate | cut -f1)
[[ -z $current || $current =~ ^[0-9a-f]{40}$ ]] || die "Invalid remote candidate SHA."
# The helper's shell expands this exported path when Git requests credentials.
# shellcheck disable=SC2016
git -c credential.helper= -c 'credential.helper=!bash "$FORK_RESOLVER_CREDENTIAL_HELPER"' push --atomic \
  --force-with-lease="sync/candidate:$current" "$fork_url" \
  HEAD:refs/heads/sync/candidate "+$upstream_sha:refs/heads/upstream-main"
fork_gh issue comment "$issue_number" --repo "$fork_repo" --body-file - <"$summary_file"
checks_run_url=$(fork_gh workflow run fork-sync.yml --repo "$fork_repo" --ref main \
  -f mode=resume -f "candidate_sha=$candidate_sha" -f "request_run_id=$1")
checks_run_id=${checks_run_url##*/}
valid_run_id "$checks_run_id" && [[ $checks_run_url == "https://github.com/$fork_repo/actions/runs/$checks_run_id" ]] ||
  die "Workflow dispatch did not return its validation run URL."
printf '%s\n' "$checks_run_url"
jq --arg sha "$candidate_sha" --arg run "$checks_run_id" --argjson now "$(date +%s)" \
  '. + {status:"published", candidate_sha:$sha, checks_run_id:$run, published_at:$now}' "$ledger" | write_ledger
echo "Published candidate $candidate_sha and dispatched resume for request $1."
