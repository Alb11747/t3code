#!/usr/bin/env bash
# Promote a published candidate once its checks pass and Codex's review of that
# exact SHA finds nothing. Anything else leaves the review PR for a person.
# Exit 0 dispatched promotion, 3 left the candidate for review; others are errors.
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]] || die "Usage: $0 <request_run_id>"
valid_run_id "$1" || die "Expected a numeric request run ID."
ledger="$resolver_home/requests/$1.json"
[[ -f $ledger ]] || die "Request has not been claimed."
jq -e '.status == "published" and (.candidate_sha | test("^[0-9a-f]{40}$"))' "$ledger" >/dev/null ||
  die "Request has not been published."
candidate_sha=$(jq -r .candidate_sha "$ledger")
main_sha=$(jq -r .main_sha "$ledger")
issue_number=$(jq -r .issue_number "$ledger")
published_at=$(jq -r .published_at "$ledger")
# Waiting does not touch the checkout or ledgers, so let other helpers run.
flock -u 9

leave_for_review() {
  printf 'Candidate `%s` was not promoted automatically: %s. It needs human review.\n' "$candidate_sha" "$1" |
    fork_gh issue comment "$issue_number" --repo "$fork_repo" --body-file -
  echo "Left candidate for review: $1" >&2
  exit 3
}

[[ $(remote_main) == "$main_sha" ]] || leave_for_review "fork main changed since the request"
codex='chatgpt-codex-connector[bot]'
deadline=$((SECONDS + ${FORK_SETTLE_TIMEOUT:-3600}))
requested_review=false
settled=false
while [[ $settled == false ]] && ((SECONDS < deadline)); do
  # The review job writes the candidate and check result once checks finish.
  pr=$(fork_gh pr list --repo "$fork_repo" --head sync/candidate --base upstream-main --state open \
    --json number,headRefOid,body,createdAt --jq '.[0] // empty')
  if [[ -n $pr ]] && jq -e --arg sha "$candidate_sha" \
    '.headRefOid == $sha and (.body | contains("as candidate `" + $sha + "`"))' <<<"$pr" >/dev/null; then
    checks=$(jq -r '.body | capture("Checks: \\*\\*(?<result>[a-z_]+)\\*\\*").result' <<<"$pr")
    [[ $checks == success ]] || leave_for_review "checks finished with $checks"
    number=$(jq -r .number <<<"$pr")
    # Codex keeps its latest review state in a summary comment.
    review=$(fork_gh api --paginate "repos/$fork_repo/issues/$number/comments" --jq ".[] | select(.user.login == \"$codex\") | .body" |
      sed -n 's/.*<!-- codex-review-state:v1 \(.*\) -->.*/\1/p' | tail -n 1)
    if [[ -n $review ]] && jq -e --arg sha "$candidate_sha" '.code_review | .commit_sha == $sha and .status == "completed"' <<<"$review" >/dev/null; then
      jq -e '.code_review.has_any_findings == false' <<<"$review" >/dev/null || leave_for_review "Codex review has findings"
      settled=true
      continue
    fi
    # Codex reviews automatically only when a PR opens, not when a later
    # candidate updates it. It ignores the workflow bot, so ask as the owner.
    if [[ $requested_review == false ]] && (($(jq -r '.createdAt | fromdateiso8601' <<<"$pr") < published_at)); then
      fork_gh pr comment "$number" --repo "$fork_repo" --body "@codex review"
      requested_review=true
    fi
  fi
  sleep 60
done
[[ $settled == true ]] || leave_for_review "checks or Codex review did not finish in time"

flock 9
[[ $(remote_main) == "$main_sha" ]] || leave_for_review "fork main changed since the request"
fork_gh workflow run fork-sync.yml --repo "$fork_repo" --ref main -f mode=promote -f "candidate_sha=$candidate_sha"
jq --argjson now "$(date +%s)" '. + {promote_dispatched_at:$now}' "$ledger" | write_ledger
echo "Checks and Codex review are clean; dispatched promotion of $candidate_sha."
