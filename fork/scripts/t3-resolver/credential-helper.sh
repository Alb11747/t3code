#!/usr/bin/env bash
# Token flows directly from gh to git; never store it or answer for other hosts.
set -euo pipefail
[[ ${1:-} == get ]] || exit 0
protocol=''
host=''
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol=$value ;;
    host) host=$value ;;
  esac
done
[[ $protocol == https && $host == github.com ]] || exit 0
read -r -a command <<<"${FORK_GH:?FORK_GH is exported by common.sh}"
printf 'username=Alb11747\npassword='
"${command[@]}" auth token
