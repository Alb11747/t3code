#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 2 && -f $2 ]] || die "Usage: $0 <request_run_id> <reason-file>"
load_claim "$1"
{
  printf 'T3 resolution failed for request run %s. **Needs local resolution** (see fork/README.md).\n\n' "$1"
  cat "$2"
} | fork_gh issue comment "$issue_number" --repo "$fork_repo" --body-file -
jq --argjson now "$(date +%s)" '. + {status:"failed", failed_at:$now}' "$ledger" | write_ledger
echo "Marked request $1 failed; resolver checkout retained for inspection."
