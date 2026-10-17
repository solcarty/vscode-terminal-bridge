# PLAN — #87

## Root cause

`sweepTerminals()` (`bridge.js`) takes `parseWorktrees()` as ground truth, and `parseWorktrees()`
runs `git worktree list --porcelain` in `host.workspaceFolders()[0]` only. A terminal in a worktree
of any other repo is "not a live worktree" and gets disposed (or SIGTERMed by pid). `startBridge()`
runs that sweep 2.5 s after every start, on both backends, so restarting the headless bridge killed
the tmux sessions `KillMode=process` had just kept alive.

## Fix (`bridge.js`)

1. **`parseWorktrees(extraDirs)` reads every repo.** Candidates: every workspace folder, the sibling
   repo of any `<repo>-worktrees` folder, and every tracked terminal's cwd that still exists. Each
   resolves to its repo with `git rev-parse --git-common-dir`; repos are deduped by that dir, and each
   is listed once with `git worktree list --porcelain`. The map is the union.
2. **Fail closed per terminal.** A row is swept only when all hold: its cwd is not listed by any repo,
   the cwd no longer exists on disk, and its shell has no live child process (`hasLiveChild`, the
   `hasAgentChild` read without the `claude` filter; `null` = unknown = keep). Every swept row logs its
   reason; every row kept for a live process logs that too.
3. **No destructive sweep at startup.** The startup sweep, on both backends, becomes a dry run that
   logs what a sweep would close. Only an explicit `/sweep` closes anything. `/sweep?dryRun=1` exposes
   the same dry run (`wouldClose`).

## Tests (`test/sweep-multi-repo.test.js`, vscode harness)

Two real git repos with one worktree each; workspace folder = only a non-git `A-worktrees` root (the
headless layout). Rows: a tab in each worktree, a tab whose dir exists but no repo lists it, a tab
whose dir was removed (dead pid), and a row whose dir was removed but whose pid is a live shell with
a child. Assert: startup closes nothing; `/sweep?dryRun=1` reports only the removed-dir tab; `/sweep`
closes only that one and disposes only its terminal.

## Docs / release

README `/sweep` section + `sweep` CLI note; CLAUDE.md design note; `package.json` patch bump
(0.33.2 → 0.33.3, or the next free patch if #83 merges first).

Live restart check (`install-headless.sh` with workers in three repos) is Sol's after install.
