#!/usr/bin/env bash
# Fails once the fork has run LIMIT jobs in the last 24 hours. GitHub froze this
# fork's Actions in October 2026 after about 650 jobs in 2.5 days (up to 315 in
# one day). The count covers every workflow's jobs that got a runner, retries
# included, so runs cancelled while waiting (fork-release's settle wait) cost
# nothing. Run from a job that already exists, so a blocked run spends no extra
# job. Needs GH_TOKEN with actions: read, GITHUB_REPOSITORY and LIMIT.
set -euo pipefail

since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
# Lists every run because reruns keep the run's created_at. Marks the runs that
# may have started jobs since the cutoff: unfinished ones, and finished ones
# updated since (a run updates when it ends, after its last job started).
# Assigned first so a failed API call fails the job instead of counting nothing.
runs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs?per_page=100" \
  --jq ".workflow_runs[] | \"\(.id) \(.status != \"completed\" or .updated_at >= \"$since\")\"")
# The listing quietly ends at 40,000 runs, which would hide newer reruns of older runs.
if (($(wc -l <<<"$runs") >= 40000)); then
  echo "::error::Over 40,000 runs; too many to count."
  exit 1
fi
# Collects jobs a runner started since the cutoff. Rerunning failed jobs copies
# the passed ones into the new attempt under new job IDs but with their original
# runner and start time, so each runner start counts once.
starts=""
for id in $(awk '$2 == "true" { print $1 }' <<<"$runs"); do
  starts+=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?filter=all&per_page=100" \
    --jq ".jobs[] | select((.runner_name // \"\") != \"\" and .started_at >= \"$since\") | \"\(.runner_id) \(.started_at)\"")$'\n'
done
used=$(awk 'NF && !seen[$0]++' <<<"$starts" | wc -l)
echo "$used of $LIMIT jobs used in the last 24 hours."
if ((used >= LIMIT)); then
  echo "::error::The fork ran $used jobs in the last 24 hours (limit $LIMIT). Rerun this workflow once older runs age out."
  exit 1
fi
