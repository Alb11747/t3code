#!/usr/bin/env bash
# Start the request's pinned sync on a fresh branch, or with --continue, run it
# again after a conflict was resolved and committed.
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 || ($# == 2 && $2 == --continue) ]] || die "Usage: $0 <request_run_id> [--continue]"
load_claim "$1"
script="$resolver_home/sync-upstream-$1.sh"
if [[ $# == 1 ]]; then
  if [[ ! -d $resolver_home/repo ]]; then
    # Don't borrow objects from /root/Sync/Repos/t3code; its synced object
    # store is incomplete.
    git clone https://github.com/Alb11747/t3code.git "$resolver_home/repo"
  fi
  cd "$resolver_home/repo"
  # Merging needs blobs of upstream commits, which a blobless clone's lazy
  # fetch from the fork cannot always supply. Convert older blobless clones;
  # promisor stays set until the full refetch succeeds, so a retry redoes it.
  if [[ $(git config --get remote.origin.promisor || true) == true ]]; then
    git config --unset remote.origin.partialclonefilter || true
    git fetch --refetch --no-tags origin
    git config remote.origin.promisor false
  fi
  git config user.name Alb11747
  git config user.email albertli_042@hotmail.com
  git config core.hooksPath /dev/null
  git fetch --no-tags "$fork_url" +refs/heads/main:refs/remotes/origin/main
  [[ $(git rev-parse refs/remotes/origin/main) == "$main_sha" ]] || die "Fork main changed; request is stale."
  if sync_in_progress; then git rebase --abort 2>/dev/null || git reset -q --merge; fi
  [[ -z $(git status --porcelain) ]] || die "Resolver checkout has unrelated changes; inspect before retrying."
  git checkout -B "resolve/$1" "$main_sha"
  git show "$main_sha:fork/scripts/sync-upstream.sh" >"$script"
  : >"$resolver_home/logs/$1-prepare.log"
else
  cd "$resolver_home/repo"
  [[ $(git branch --show-current) == "resolve/$1" ]] || die "The checkout is not on resolve/$1."
  sync_in_progress && die "Resolve and commit the stopped merge or revert first (git commit --no-edit)."
fi
# sync-upstream calls gh for merged PRs. Keep the wrapper outside the checkout.
mkdir -p "$resolver_home/bin"
cat >"$resolver_home/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
read -r -a command <<<"${FORK_GH:?FORK_GH is exported by common.sh}"
exec "${command[@]}" "$@"
EOF
chmod +x "$resolver_home/bin/gh"
export PATH="$resolver_home/bin:$PATH"
code=0
bash "$script" --onto "$upstream_sha" >>"$resolver_home/logs/$1-prepare.log" 2>&1 || code=$?
tail -n 40 "$resolver_home/logs/$1-prepare.log"
[[ $code == 0 || $code == 2 ]] || exit "$code"
if [[ $code == 2 ]]; then
  echo "Sync stopped on a conflict. Resolve the files, git add them, git commit --no-edit, then run:"
  echo "bash $0 $1 --continue"
else
  echo "Upstream is merged. Validate and publish with publish-candidate.sh $1 <summary-file>."
fi
exit "$code"
