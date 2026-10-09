# Fork changes

Every change this fork carries on top of upstream, one line each:
commit subject, why, and its upstream PR. `git log upstream-main..main` lists
the commits. Keep each entry on a single line; the sync script deletes the
line of a change whose upstream PR merged. See `fork/README.md` for how to add
or drop an entry.

- `feat(web): schedule tasks without a project`: scheduled tasks can run without picking a project. Squashes two commits by Sam Scott. Upstream: https://github.com/pingdotgg/t3code/pull/17257
- `fix(server): launch projectless scheduled tasks in scratch folders`: Scratch launches (including projectless scheduled tasks) always get a per-thread folder, even with a saved worktree strategy, and retries reuse the folder the first create claimed. Pairs with PR 17257. Upstream: none yet
- `fix(mcp): return delegated task handles before client timeouts`: blocking delegation waits return a task handle before MCP clients time out (30 s default, 45 s cap). By maria-rcks. Upstream: https://github.com/pingdotgg/t3code/pull/15622
- `fix(server): skip Windows cleanup for exited child processes`: pnpm patch to `@effect/platform-node-shared` that skips `taskkill /T` for a child that already exited, since its PID may now belong to an unrelated process. Upstream: https://github.com/pingdotgg/t3code/pull/16007
- `fix(server): skip unsupported native Codex usage reads`: custom providers and API-key accounts no longer call `account/rateLimits/read`, which fails for them and marked usage as broken. Upstream: none yet
- `docs(fork)` and `ci(fork)` commits: this guide, the change list, and the sync and release tooling. Fork-only.
