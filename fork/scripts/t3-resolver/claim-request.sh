#!/usr/bin/env bash
# Claim authoritative Actions metadata; webhook bodies and issue text are unused.
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# -le 1 ]] || die "Usage: $0 [request_run_id]"
run_id=${1:-}
[[ -z $run_id ]] || valid_run_id "$run_id" || die "Expected a numeric request run ID."
# Issue search can lag behind creation when the webhook starts immediately.
issue_number=$(fork_gh api --method GET "repos/$fork_repo/issues" -f state=open -f labels=fork-sync -f per_page=100 --jq '[.[] | select(.pull_request == null)][0].number // empty')
[[ $issue_number =~ ^[1-9][0-9]*$ ]] || exit 3

if [[ -z $run_id ]]; then
  # GitHub returns newest runs first. Only a run with the handoff artifact counts.
  runs=$(fork_gh api --method GET "repos/$fork_repo/actions/workflows/fork-sync.yml/runs" -f branch=main -f per_page=100)
  while read -r candidate; do
    artifacts=$(fork_gh api "repos/$fork_repo/actions/runs/$candidate/artifacts")
    if jq -e '.artifacts[] | select(.name == "sync-request" and .expired == false)' <<<"$artifacts" >/dev/null; then
      run_id=$candidate
      break
    fi
  done < <(jq -r '.workflow_runs[].id' <<<"$runs")
fi
[[ -n $run_id ]] || exit 3
valid_run_id "$run_id" || die "Invalid run ID returned by GitHub."
run=$(fork_gh api "repos/$fork_repo/actions/runs/$run_id")
jq -e --arg repo "$fork_repo" --arg id "$run_id" '
  (.id | tostring) == $id and .repository.full_name == $repo and
  .head_repository.full_name == $repo and .path == ".github/workflows/fork-sync.yml" and
  .head_branch == "main" and (.event == "schedule" or .event == "workflow_dispatch")
' <<<"$run" >/dev/null || die "Run is not this fork main sync workflow."
artifacts=$(fork_gh api "repos/$fork_repo/actions/runs/$run_id/artifacts")
artifact_id=$(jq -r '[.artifacts[] | select(.name == "sync-request" and .expired == false)] | sort_by(.id) | last | .id // empty' <<<"$artifacts")
[[ $artifact_id =~ ^[1-9][0-9]*$ ]] || die "No sync-request artifact available."
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
fork_gh api "repos/$fork_repo/actions/artifacts/$artifact_id/zip" >"$temporary/request.zip"
# Extract just the expected member, never arbitrary paths from the archive.
unzip -p "$temporary/request.zip" sync-request.json >"$temporary/request.json"
validate_request "$temporary/request.json"
jq -e --arg id "$run_id" --arg attempt "$(jq -r .run_attempt <<<"$run")" '
  (.request_run_id | tostring) == $id and (.run_attempt | tostring) == $attempt
' "$temporary/request.json" >/dev/null || die "Artifact run/attempt does not match."
ledger="$resolver_home/requests/$run_id.json"
now=$(date +%s)
if [[ -f $ledger ]]; then
  status=$(jq -r .status "$ledger")
  [[ $status != published && $status != superseded ]] || exit 3
fi
if [[ $(remote_main) != "$(jq -r .main_sha "$temporary/request.json")" ]]; then
  jq --argjson issue "$issue_number" --argjson now "$now" '. + {status:"superseded", updated_at:$now, issue_number:$issue}' "$temporary/request.json" | write_ledger
  exit 3
fi
if [[ -f $ledger ]] && jq -e --argjson now "$now" '.status == "claimed" and ($now - .claimed_at < 10800)' "$ledger" >/dev/null; then
  exit 4
fi
# One dedicated checkout cannot safely service two agents at once.
for other in "$resolver_home"/requests/*.json; do
  [[ -f $other && $other != "$ledger" ]] || continue
  if jq -e --argjson now "$now" '.status == "claimed" and ($now - .claimed_at < 10800)' "$other" >/dev/null; then
    exit 4
  fi
done
jq --argjson issue "$issue_number" --argjson now "$now" '. + {status:"claimed", claimed_at:$now, issue_number:$issue}' "$temporary/request.json" | write_ledger
cat "$temporary/request.json"
