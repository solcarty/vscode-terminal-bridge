# Claude Code — vscode-terminal-bridge

## What this is

A VS Code extension that exposes a local HTTP API for managing terminal tabs programmatically. Lets external scripts, Claude agents, and shell tools open, rename, close, and set status on named terminals without AppleScript or keystrokes.

Application-agnostic — any repo or process can call it via HTTP. Not coupled to any specific consuming project.

## How it works

- On activation: starts an HTTP server on `127.0.0.1:31415` (increments port if taken)
- Writes the active port to `.vscode-bridge-port` in every workspace folder
- Scripts discover their window's port: `PORT=$(cat "$PWD/.vscode-bridge-port")`

## Key endpoints

All endpoints are GET with query-string params (not POST/JSON — see `extension.js`).

| Endpoint | Purpose |
|----------|---------|
| `/open-terminal` | Open a named terminal in a given cwd |
| `/close-terminal` | Close a named terminal (falls back to PID kill if registry desynced) |
| `/rename-terminal` | Rename / set status icon via `status=` (or `label=`, or `quiet=1`) |
| `/sweep` | Dispose terminals whose cwd no longer maps to a live `git worktree` |
| `/add-folder` / `/remove-folder` | Attach/detach a workspace folder |
| `/reindex` | Re-link open terminals to persisted metadata |
| `/ping` | Health check — returns port, pid, workspace folders |

## Calling it — use the bundled CLI, not raw curl

Don't hand-roll curl calls. The extension bundles `bin/vscode-bridge.sh` + `bin/bridgectl.sh` and writes them to `~/.vscode-terminal-bridge/bin/` on every activation, so the calling convention (port discovery, GET param shapes, status-map values) stays in sync with whatever extension version is installed:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open <name> <cwd> [cmd] [icon] [color]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh status <name> <state>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh close <name>
```

Source of these scripts is `bin/` in this repo — edit there, not the installed copy under `~/.vscode-terminal-bridge/`.

## Status icons (for rename-terminal `status=` param)

| Status | Icon | Color |
|--------|------|-------|
| `working` | spinning loader | cyan |
| `idle` | pause | green |
| `error` | error | red |
| `needs-input` | bell | yellow |
| `subagent` | array symbol | magenta |
| `task-done` | checkmark | green |

## Spawning a named terminal

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open my-task \
  /path/to/worktree-or-repo \
  "some-command --with-args" \
  "" terminal.ansiMagenta
```

## Key file

`extension.js` — the entire extension in one file. No build step required.

## Packaging

```bash
npx vsce package   # produces a .vsix
```

Install in VS Code: `Extensions → ... → Install from VSIX`
