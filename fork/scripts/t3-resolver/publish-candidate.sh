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
rebase_in_progress && die "Finish the rebase before publishing."
[[ -z $(git status --porcelain --untracked-files=normal) ]] || die "Candidate checkout must be clean (ignored files are allowed)."
git merge-base --is-ancestor "$upstream_sha" HEAD || die "Candidate is not based on the requested upstream SHA."
[[ -z $(git rev-list --merges "$upstream_sha..HEAD") ]] || die "Candidate history contains merge commits."
[[ $(remote_main) == "$main_sha" ]] || die "Fork main changed; request is stale."
candidate_sha=$(git rev-parse HEAD)
current=$(git ls-remote "$fork_url" refs/heads/sync/candidate | cut -f1)
[[ -z $current || $current =~ ^[0-9a-f]{40}$ ]] || die "Invalid remote candidate SHA."
export FORK_GH
FORK_GH=${FORK_GH:-ssh -o BatchMode=yes lazarus gh}
# The helper's shell expands this exported path when Git requests credentials.
# shellcheck disable=SC2016
git -c credential.helper= -c 'credential.helper=!bash "$FORK_RESOLVER_CREDENTIAL_HELPER"' push --atomic \
  --force-with-lease="sync/candidate:$current" "$fork_url" \
  HEAD:refs/heads/sync/candidate "+$upstream_sha:refs/heads/upstream-main"
fork_gh issue comment "$issue_number" --repo "$fork_repo" --body-file - <"$summary_file"
fork_gh workflow run fork-sync.yml --repo "$fork_repo" --ref main \
  -f mode=resume -f "candidate_sha=$candidate_sha" -f "request_run_id=$1"
jq --arg sha "$candidate_sha" --argjson now "$(date +%s)" '. + {status:"published", candidate_sha:$sha, published_at:$now}' "$ledger" | write_ledger
echo "Published candidate $candidate_sha and dispatched resume for request $1."
