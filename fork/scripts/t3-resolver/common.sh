#!/usr/bin/env bash
# Shared state and validated GitHub access; source from the resolver helpers.
# These globals are consumed by the scripts that source this file.
# shellcheck disable=SC2034
set -euo pipefail

resolver_home=${FORK_RESOLVER_HOME:-/root/Local/Agents/Work/t3code-fork-resolver}
fork_repo=Alb11747/t3code
fork_url=${FORK_PUSH_URL:-https://github.com/Alb11747/t3code.git}
helpers_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Exported so the credential helper and prepare's gh wrapper use it too.
export FORK_GH=${FORK_GH:-bash $helpers_dir/lazarus-gh.sh}
read -r -a gh_command <<<"$FORK_GH"
mkdir -p "$resolver_home/requests" "$resolver_home/logs"
# Serialize helper mutations. The claimed timestamp guards the agent's work
# between invocations, when this short-lived lock is no longer held.
exec 9>"$resolver_home/resolver.lock"
flock 9

fork_gh() { "${gh_command[@]}" "$@"; }
die() { echo "$*" >&2; exit 1; }
valid_run_id() { [[ $1 =~ ^[1-9][0-9]*$ ]]; }

validate_request() {
  jq -e '
    def id: (type == "number" or type == "string") and (tostring | test("^[1-9][0-9]*$"));
    def sha: type == "string" and test("^[0-9a-f]{40}$");
    type == "object" and (.request_run_id | id) and (.run_attempt | id) and
    (.main_sha | sha) and (.upstream_sha | sha) and (.stopped_commit | sha) and
    (.stopped_subject | type == "string") and
    (.created_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$") and (fromdateiso8601 > 0))
  ' "$1" >/dev/null || die "Invalid sync-request metadata."
}

load_claim() {
  valid_run_id "$1" || die "Expected a numeric request run ID."
  ledger="$resolver_home/requests/$1.json"
  [[ -f $ledger ]] || die "Request has not been claimed."
  validate_request "$ledger"
  jq -e --arg run "$1" '
    (.request_run_id | tostring) == $run and .status == "claimed" and
    (.issue_number | type == "number" and . > 0 and floor == .)
  ' "$ledger" >/dev/null || die "Request is not claimed."
  main_sha=$(jq -r .main_sha "$ledger")
  upstream_sha=$(jq -r .upstream_sha "$ledger")
  issue_number=$(jq -r .issue_number "$ledger")
}

write_ledger() {
  local temporary
  temporary=$(mktemp "$resolver_home/requests/.ledger.XXXXXX")
  cat >"$temporary"
  mv "$temporary" "$ledger"
}

remote_main() {
  fork_gh api "repos/$fork_repo/git/ref/heads/main" --jq .object.sha
}

rebase_in_progress() {
  [[ -d $(git rev-parse --git-path rebase-merge) || -d $(git rev-parse --git-path rebase-apply) ]]
}
