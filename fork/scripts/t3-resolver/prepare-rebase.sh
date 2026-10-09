#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]] || die "Usage: $0 <request_run_id>"
load_claim "$1"
if [[ ! -d $resolver_home/repo ]]; then
  # Blobless: fast, and file contents arrive on demand. Don't borrow objects
  # from /root/Sync/Repos/t3code; its synced object store is incomplete.
  git clone --filter=blob:none https://github.com/Alb11747/t3code.git "$resolver_home/repo"
fi
cd "$resolver_home/repo"
git config user.name Alb11747
git config user.email albertli_042@hotmail.com
git config core.hooksPath /dev/null
git fetch --no-tags "$fork_url" +refs/heads/main:refs/remotes/origin/main
[[ $(git rev-parse refs/remotes/origin/main) == "$main_sha" ]] || die "Fork main changed; request is stale."
if rebase_in_progress; then git rebase --abort; fi
[[ -z $(git status --porcelain) ]] || die "Resolver checkout has unrelated changes; inspect before retrying."
git checkout -B "resolve/$1" "$main_sha"
git show "$main_sha:fork/scripts/sync-upstream.sh" >"$resolver_home/sync-upstream-$1.sh"
# sync-upstream calls gh for merged PRs. Keep the wrapper outside the checkout.
mkdir -p "$resolver_home/bin"
cat >"$resolver_home/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
read -r -a command <<<"${FORK_GH:-ssh -o BatchMode=yes lazarus gh}"
exec "${command[@]}" "$@"
EOF
chmod +x "$resolver_home/bin/gh"
export PATH="$resolver_home/bin:$PATH"
code=0
bash "$resolver_home/sync-upstream-$1.sh" --onto "$upstream_sha" >"$resolver_home/logs/$1-prepare.log" 2>&1 || code=$?
cat "$resolver_home/logs/$1-prepare.log"
[[ $code == 0 || $code == 2 ]] || exit "$code"
echo "Rebase exit status: $code. Resolve conflicts, continue/skip each commit, then run:"
echo "bash $resolver_home/sync-upstream-$1.sh --finish"
echo "Validate and publish with publish-candidate.sh $1 <summary-file>."
exit "$code"
