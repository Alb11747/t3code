#!/usr/bin/env bash
# Bring fork main up to upstream's newest nightly before a change is pushed, so
# the release that push starts builds on current upstream. Syncs through the
# Fork sync workflow, which checks and promotes a clean merge itself.
#
# Exit codes: 0 = fork main contains the newest nightly; 3 = a sync request is
# open (a conflict being resolved), so wait for it to settle before pushing;
# others are errors. Requires `gh`.
set -euo pipefail
repo=Alb11747/t3code

open_request() {
  gh issue list -R "$repo" --label fork-sync --state open --json url --jq '.[0].url // empty'
}
wait_for_request() {
  echo "Sync request $1 is open. Wait for it to be promoted (or resolve it, see fork/README.md) before pushing." >&2
  exit 3
}
# Upstream commits in the nightly that fork main lacks.
missing() {
  gh api "repos/$repo/compare/main...pingdotgg:t3code:$1" --jq .ahead_by
}

request=$(open_request)
[[ -z $request ]] || wait_for_request "$request"

# Like fork-sync.yml, pick the newest nightly by publication time.
tag=$(gh release list -R pingdotgg/t3code --limit 100 --json tagName,publishedAt,isDraft \
  --jq '[.[] | select((.isDraft | not) and (.tagName | contains("-nightly.")))] | sort_by(.publishedAt) | last.tagName // empty')
[[ -n $tag ]] || { echo "No upstream nightly in upstream's recent releases." >&2; exit 1; }
if [[ $(missing "$tag") == 0 ]]; then
  echo "Fork main already contains upstream nightly $tag."
  exit 0
fi

# Join a sync that is already running (the watchdog's or another agent's).
run=$(gh run list -R "$repo" --workflow fork-sync.yml --limit 20 --json databaseId,status \
  --jq '[.[] | select(.status != "completed")] | first.databaseId // empty')
if [[ -z $run ]]; then
  echo "Fork main lacks upstream nightly $tag; dispatching Fork sync." >&2
  url=$(gh workflow run fork-sync.yml -R "$repo" 2>&1 | grep -o 'https://[^ ]*/runs/[0-9]*')
  run=${url##*/}
fi
echo "Waiting for Fork sync run https://github.com/$repo/actions/runs/$run" >&2
gh run watch "$run" -R "$repo" --exit-status >/dev/null ||
  { echo "Fork sync run $run failed; inspect it before pushing." >&2; exit 1; }

request=$(open_request)
[[ -z $request ]] || wait_for_request "$request"
if [[ $(missing "$tag") == 0 ]]; then
  echo "Synced: fork main now contains upstream nightly $tag."
  exit 0
fi
echo "Fork sync finished, but fork main still lacks upstream nightly $tag." >&2
exit 1
