# Fork guide

This repository is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code):
upstream `main` plus a short series of patches. GitHub Actions rebases the
patches onto upstream, checks them, and publishes Windows x64 and Linux x64
builds that installed copies pick up through the in-app **Install update** button.

Read this before changing anything here. Upstream's `AGENTS.md` still governs
code style, testing and conventions.

## Layout

| Path                                 | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `fork/CHANGES.md`                    | One line per fork change: what, why, upstream PR.             |
| `fork/scripts/sync-upstream.sh`      | Rebases the patches onto upstream; drops merged upstream PRs. |
| `fork/scripts/resolve-with-codex.sh` | Lets Codex resolve a stopped rebase, one commit at a time.    |
| `fork/prompts/resolve-conflict.md`   | Codex's conflict-resolution instructions.                     |
| `.github/workflows/fork-sync.yml`    | Every 6 hours: sync, check, promote or open a review PR.      |
| `.github/workflows/fork-checks.yml`  | Upstream's release checks on GitHub-hosted runners.           |
| `.github/workflows/fork-release.yml` | On push to `main`: check, build, publish a GitHub prerelease. |

Everything else is upstream code. Upstream's own workflows are disabled in the
fork's GitHub settings (they need upstream's runners and credentials, or
automate upstream's issues and PRs), so the fork never edits them. The one
exception is `release-desktop.yml`, which `fork-release.yml` calls.

## Branches and history

- `main` is upstream `main` plus the fork's commits on top, always linear. Sync
  rebases and force-pushes it, so never merge upstream into it.
- `upstream-main` mirrors upstream for review diffs; `sync/candidate` is the
  latest rebased candidate. Both are written by the sync workflow.
- Locally, `origin` may point at upstream. Add the fork as its own remote
  (`git remote add fork https://github.com/Alb11747/t3code.git`) and work on a
  local `fork-main` branch tracking `fork/main`.
- Commits follow Conventional Commits, as upstream does.

## Adding a change

1. Start from the fork's `main` (`git fetch fork && git switch fork-main && git reset --hard fork/main`
   if it was rewritten by a sync and you have no local work).
2. Make one focused commit per change. Keep the diff small and inside existing
   files' structure: every line touched in an upstream file is a potential
   conflict on each sync. Prefer new files and narrow hooks over edits spread
   across upstream files.
3. If the change has an upstream PR (yours or someone else's), end the commit
   message with a trailer so sync drops it automatically once upstream merges:

   ```
   Upstream-PR: https://github.com/pingdotgg/t3code/pull/12345
   ```

4. Add an entry to `fork/CHANGES.md`. That file belongs to the single
   `docs(fork)` commit, so amend it there instead of adding the entry to your
   change's commit (entries in separate commits conflict when one is dropped):

   ```sh
   git commit --fixup="$(git log -1 --format=%H -- fork/CHANGES.md)" -- fork/CHANGES.md
   GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash "$(git merge-base HEAD fork/upstream-main)"
   ```

5. Validate as `AGENTS.md` describes (package typecheck, touched tests,
   `vp check` on changed files).
6. Push `main` with `--force-with-lease`. The push starts **Fork release**,
   which checks, builds and publishes. A fast-forward push that only touches
   `fork/*.md` skips the release; a force-push always releases, because GitHub
   can't tell which files changed.

To change or fix an existing fork change, amend its commit (`git commit
--fixup=<sha>` plus an autosquash rebase) rather than stacking fix-up commits.
To remove one, drop its commit and its `CHANGES.md` entry.

## Syncing with upstream

**Fork sync** runs every 6 hours (and on demand from the Actions tab):

1. `sync-upstream.sh` fetches upstream `main` and rebases the fork commits onto
   it, dropping commits whose `Upstream-PR` has merged and pruning their entries.
2. On a conflict, `resolve-with-codex.sh` lets Codex resolve it (needs the
   `OPENAI_API_KEY` secret). Without the key, or if Codex fails, the run opens
   a `fork-sync` issue.
3. The candidate is pushed to `sync/candidate` and checked with `fork-checks.yml`.
4. Clean rebase and green checks: `main` moves to the candidate and a release
   follows. Codex-resolved or failing candidates get a review PR
   (`sync/candidate` into `upstream-main`) instead. Ship one by running
   **Fork sync** with **promote** checked; merging the PR does nothing.
   Codex's GitHub code review reviews these PRs when automatic review is on
   for this repository in ChatGPT's Codex settings. That uses the plan's Code
   Review usage; Codex ignores `@codex` comments from the workflow's bot.

To resolve a conflict locally:

```sh
git fetch fork && git switch fork-main   # local branch tracking fork/main
fork/scripts/sync-upstream.sh            # exit code 2 means it stopped on a conflict
# resolve the files, `git add` them, then `git rebase --continue`; repeat until done
fork/scripts/sync-upstream.sh --finish   # prunes CHANGES.md entries for merged PRs
# validate, then push: git push --force-with-lease fork HEAD:main
```

`fork/scripts/resolve-with-codex.sh <copy of fork/prompts/resolve-conflict.md>`
runs the same Codex loop locally (copy the prompt outside the repo first; the
checkout changes during the rebase).

## Releases and updates

- Versions use upstream's nightly format, `<base>-nightly.<date>.<run>`, so
  installs follow the **Nightly** update channel. A copy switched to the
  Latest channel in settings won't see fork updates.
- The update feed is this repository's releases, set at build time from
  `GITHUB_REPOSITORY`. The app keeps upstream's app ID, so installing a fork
  build replaces official T3 Code and keeps its data.
- Builds are unsigned: Windows SmartScreen warns on first install; updates
  still work. macOS is not built (auto-update requires a paid signing identity).
- T3 Connect uses upstream's production service. The repository variables
  `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`
  and `RELAY_URL` hold the public values official builds ship with (taken from
  an official nightly bundle). If upstream changes them, update the variables
  from the latest official build; without them builds simply lack T3 Connect.

## Repository settings

| Setting                | Kind     | Purpose                                                                |
| ---------------------- | -------- | ---------------------------------------------------------------------- |
| `FORK_DEPLOY_KEY`      | secret   | Private key of the write-enabled deploy key "fork-sync" (see below).   |
| `OPENAI_API_KEY`       | secret   | Optional. Lets Codex resolve sync conflicts in Actions.                |
| `CODEX_MODEL`          | variable | Optional. Model for Codex conflict resolution.                         |
| `CLERK_*`, `RELAY_URL` | variable | T3 Connect public client settings (see Releases and updates).          |
| Upstream workflows     | Actions  | Disabled except `release-desktop.yml`; Fork sync re-disables new ones. |

Sync pushes over SSH with a deploy key instead of `GITHUB_TOKEN`, because
`GITHUB_TOKEN` cannot push upstream's workflow-file changes and its pushes don't
start `fork-release.yml`. To rotate the key: generate one
(`ssh-keygen -t ed25519 -N '' -f key`), add `key.pub` as a deploy key with write
access (`gh repo deploy-key add key.pub --allow-write --title fork-sync`), store
`key` with `gh secret set FORK_DEPLOY_KEY < key`, then delete both files and
the old deploy key.
