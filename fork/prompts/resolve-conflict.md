You are resolving a merge conflict in a personal fork of T3 Code
(github.com/pingdotgg/t3code). The fork is a short series of patches rebased
onto upstream `main`. A rebase stopped while applying the fork commit shown
below, and the files listed below contain conflict markers.

Goal: keep upstream's current code and apply the fork commit's intent on top of
it, the way the commit's author would have written it against today's upstream.

Rules:

- Edit only the conflicted files, plus files the commit clearly needs moved or
  renamed because upstream reorganized code. Do not run git commands that
  change state (no add, commit, rebase, checkout, reset, or stash); the caller
  stages your edits and continues the rebase.
- Remove every conflict marker.
- Prefer upstream's structure, names, and APIs. When upstream moved or renamed
  something the commit touches, follow the move instead of restoring old code.
- If upstream already implements what the commit does, resolve to upstream's
  version. The caller then drops the empty commit.
- Read `fork/CHANGES.md` and the commit message for each change's intent, and
  `AGENTS.md` for repository conventions.
- Where practical, check your resolution with the package's typecheck or the
  touched tests (`vp run typecheck` and `vp test run <file>` inside the
  package). Dependencies may be missing; that is not a reason to skip the
  resolution.
- End with a short summary: what conflicted, how you resolved it, and anything
  a reviewer should check.
