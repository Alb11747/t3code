# Fork changes

Every change this fork carries on top of upstream, one line each:
commit subject, why, and related upstream issues and PRs. `git log upstream-main..main`
lists the commits. Include issue links even when no PR exists yet; a related
issue may cover more than the fork's fix. Keep each entry on a single line;
the sync script deletes the line of a change whose upstream PR merged. Closing
an issue alone does not drop a patch. See `fork/README.md` for how to add or drop
an entry.

- `feat(web): schedule tasks without a project`: scheduled tasks can run without picking a project. Squashes two commits by Sam Scott. Issue: none linked. PR: https://github.com/pingdotgg/t3code/pull/17257
- `fix(server): launch projectless scheduled tasks in scratch folders`: Scratch launches (including projectless scheduled tasks) always get a per-thread folder, even with a saved worktree strategy, and retries reuse the folder the first create claimed. Pairs with PR 17257. Issue: none linked. PR: none yet
- `fix(mcp): return delegated task handles before client timeouts`: blocking delegation waits return a task handle before MCP clients time out (30 s default, 45 s cap). By maria-rcks. Issue: https://github.com/pingdotgg/t3code/issues/11168. PR: https://github.com/pingdotgg/t3code/pull/15622
- `fix(server): skip Windows cleanup for exited child processes`: pnpm patch to `@effect/platform-node-shared` that skips `taskkill /T` for a child that already exited, since its PID may now belong to an unrelated process. Related issue: https://github.com/pingdotgg/t3code/issues/2537. PR: https://github.com/pingdotgg/t3code/pull/16007
- `fix(server): skip unsupported native Codex usage reads`: custom providers and API-key accounts no longer call `account/rateLimits/read`, which fails for them and marked usage as broken. Issue: none linked. PR: none yet
- `fix(server): tell agents to link outside files by absolute path`: files outside the workspace remain clickable in T3 clients when agents use absolute Markdown link targets. Issue: none linked. PR: none yet
- `fix(server): detect Windows npm provider binaries for updates`: Codex instances configured with npm's native executable can update through T3, and manual-only installs no longer suggest an unavailable update action. Issue: none linked. PR: none yet
- `feat(web): download files from chat file links`: the context menu on chat file links offers "Download file" for any host file the connection can read, including files outside the workspace, so remote clients can fetch agent output. Issue: none linked. PR: none yet
- `fix(fork): show release deltas and link fork notes`: release notes list upstream changes and only new or updated fork patches since the previous published build, even after rebases; desktop release links follow the configured updater repository. Issue: none linked. PR: none yet
- `docs(fork)` and `ci(fork)` commits: this guide, the change list, and the sync and release tooling. Fork-only.
