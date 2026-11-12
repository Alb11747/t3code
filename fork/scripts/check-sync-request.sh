#!/usr/bin/env bash
# Run before pushing to fork main. Pushes no longer sync with upstream first:
# syncs run only from the Lazarus watchdog, about every three days, because
# each conflicting sync starts a model-driven resolver (fork/README.md,
# Syncing with upstream). An open sync request still blocks pushes, since
# promotion rejects its candidate once main moves.
#
# Exit codes: 0 = no sync request is open; 3 = one is open, so wait for it to
# settle before pushing; others are errors. Requires `gh`.
set -euo pipefail

request=$(gh issue list -R Alb11747/t3code --label fork-sync --state open --json url --jq '.[0].url // empty')
if [[ -n $request ]]; then
  echo "Sync request $request is open. Wait for it to be promoted (or resolve it, see fork/README.md) before pushing." >&2
  exit 3
fi
echo "No sync request is open."
