# PLAN — #79

1. `headless.js` `tmuxRun`: add `child.stdin.on('error', () => {})` before `stdin.end`. EPIPE means tmux
   exited before reading; outcome still comes from `close` (exit code + stderr). Export `tmuxRun`.
2. `test/tmux-run-epipe.test.js`: fake `tmux` (VSCODE_BRIDGE_TMUX) that exits at once; many runs with a
   large stdin so EPIPE is deterministic. Asserts no uncaughtException and results match exit code.
   Needs no real tmux. Fails without the fix.
3. Bump `package.json` 0.33.0 -> 0.33.1. No CHANGELOG file exists; release notes are generated from PRs.
4. Run `npm test`, then /pre-pr and open PR; wait for CI green.
