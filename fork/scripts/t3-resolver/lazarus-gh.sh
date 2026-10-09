#!/usr/bin/env bash
# Runs gh on the Lazarus host, where it is logged in. ssh joins its arguments
# into one remote command line, so quote each one for the remote shell;
# otherwise filters like '.[0].number // empty' are split apart.
set -euo pipefail
exec ssh -o BatchMode=yes lazarus "gh $(printf '%q ' "$@")"
