#!/usr/bin/env bash
set -euo pipefail

gh workflow list --all --limit 500 --json path,state --jq '.[] | select(.state == "active") | .path' |
  while read -r workflow_path; do
    case "$(basename "$workflow_path")" in
      fork-* | release-desktop.yml) ;;
      *) gh workflow disable "$(basename "$workflow_path")" ;;
    esac
  done
