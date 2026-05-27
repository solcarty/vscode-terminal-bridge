# VS Code Terminal Bridge

A tiny VS Code extension that exposes a local HTTP API for managing terminal tabs programmatically — open, rename, and close named terminals from bash scripts, shell tools, or any process that can make an HTTP request.

Built to solve a real problem: VS Code extensions and external scripts **cannot** reliably open terminals using AppleScript, keystrokes, or CLI flags. This extension uses the native `vscode.window.createTerminal` API, exposed via a local-only HTTP server.

## How it works

On activation, the extension starts an HTTP server on `127.0.0.1`. It tries port **31415** first; if that port is already taken (e.g. a second VS Code window is open), it increments until it finds a free port (`31416`, `31417`, …).

Once bound, the extension writes the active port to a `.vscode-bridge-port` file in **every workspace folder**. Scripts discover their window's port by reading this file from the repo root — no hardcoded port, no guessing which window is which.

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
```

> **Add `.vscode-bridge-port` to `.gitignore`** — it's machine-local state and should not be committed.

Terminals opened via `/open-terminal` are registered in an internal Map (`name → terminal instance`). Terminal metadata (`name`, `cwd`, `label`, `color`) is persisted to VS Code workspace state. On every window activation the extension scans all open terminals and re-links any that match a persisted entry or a live `git worktree list` path — so `/rename-terminal` and `/close-terminal` keep working after a **Developer: Reload Window** without manual intervention.

> **Important:** Only terminals opened via `/open-terminal` with a `name` are tracked. Terminals opened manually in VS Code are not in the registry.

## Multi-window setup

When two VS Code windows are open, each gets its own bridge on a different port:

| Window | Port | `.vscode-bridge-port` |
| ------ | ---- | --------------------- |
| First window to activate | `31415` | `31415` |
| Second window | `31416` | `31416` |

Scripts running inside a VS Code terminal read `.vscode-bridge-port` from their working directory, so they always talk to the bridge in **their own window** — no configuration needed.

## Installation

### Option A: Install from VSIX (recommended)

Download the latest `.vsix` from [Releases](../../releases) and run:

```bash
# VS Code stable:
code --install-extension terminal-bridge-*.vsix

# VS Code Insiders:
code-insiders --install-extension terminal-bridge-*.vsix
```

Then reload VS Code (`Cmd+Shift+P` → **Developer: Reload Window**).

### Option B: Manual (clone and drop in)

Clone once into a version-free directory — `git pull` inside it always gives you the latest:

```bash
# VS Code stable:
git clone https://github.com/solcarty/vscode-terminal-bridge \
  ~/.vscode/extensions/sdo.terminal-bridge

# VS Code Insiders:
git clone https://github.com/solcarty/vscode-terminal-bridge \
  ~/.vscode-insiders/extensions/sdo.terminal-bridge
```

To update later:

```bash
cd ~/.vscode-insiders/extensions/sdo.terminal-bridge && git pull
```

Then reload VS Code.

## Workspace requirement

The `.vscode-bridge-port` file is written to each **workspace folder** — a path that VS Code has open as a root in the Explorer. If you open a loose file or a folder that isn't part of a workspace, the port file won't be written and port discovery will fall back to `31415`.

For the port file to work correctly, your repo root must be open as a workspace folder (the normal case when you open a folder with `code .` or `code-insiders .`). When you add worktrees with `/add-folder`, the extension writes the port file there too, so hooks and scripts running inside a worktree terminal always find the right port.

## VS Code title format (recommended)

For the best experience, set your terminal tab title format to show both the dynamic status and the folder name.

**Settings → Terminal › Integrated › Tabs: Title** (or edit `settings.json`):

```json
"terminal.integrated.tabs.title": "${sequence}${separator}${rootWorkspaceFolderName}"
```

This gives you:

- `${rootWorkspaceFolderName}` — always shows the workspace folder (e.g. `SOL-60`) on the right
- `${sequence}` — shows any OSC title sequences emitted by the shell on the left
- When a terminal is renamed via `/rename-terminal`, the static label overrides this format entirely

## API

All examples use port discovery via `.vscode-bridge-port`. Substitute `$PORT` with the value from that file, or hardcode `31415` if you only ever have one VS Code window open.

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
```

---

### `GET /ping`

Health check. Returns the active port, workspace folders, and process info — fully identifying which VS Code window the bridge is running in.

```bash
curl http://127.0.0.1:$PORT/ping
```

```json
{
  "ok": true,
  "port": 31415,
  "ipcHook": "/Users/you/Library/Application Support/Code - Insiders/1.12-main.sock",
  "pid": 1563,
  "workspaceFolders": [
    "/Users/you/Workspace/my-repo",
    "/Users/you/worktrees/my-repo/SOL-42"
  ]
}
```

`workspaceFolders` lets you confirm you're talking to the right window — each window's bridge lists only its own workspace roots.

---

### `GET /reindex`

Manually triggers a re-index scan. Useful right after a **Developer: Reload Window** before the window has received focus, or from a startup script that wants to confirm the registry is populated.

```bash
curl http://127.0.0.1:$PORT/reindex
# {"ok":true,"reindexed":3}
```

The `reindexed` count is the number of terminals newly linked in this call (0 if everything was already tracked).

---

### `GET /open-terminal`

Opens a named terminal tab and optionally runs a command in it.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | No | Terminal tab label and registry key |
| `cwd` | No | Working directory (URL-encoded path) |
| `cmd` | No | Shell command to run on open (URL-encoded) |
| `color` | No | Tab color — VS Code ThemeColor ID (e.g. `terminal.ansiGreen`) |
| `icon` | No | Tab icon — VS Code ThemeIcon ID (e.g. `hubot`, `check`, `error`). Set once at creation to mark the terminal's identity. |
| `focus` | No | Set `focus=1` to steal keyboard focus. Default: focus is **preserved** (the editor keeps focus). |

**Focus behaviour:** by default, spawning a terminal never yanks focus from the editor. Pass `focus=1` only when you explicitly want the user to land in the new terminal.

**`CLAUDE_TAB_NAME` injection:** when `name` is provided, the extension automatically runs `export CLAUDE_TAB_NAME=<name>` in the shell before executing `cmd`. Hook scripts can then read `$CLAUDE_TAB_NAME` instead of inferring the tab name from `basename "$PWD"` — which doesn't hold for non-worktree terminals.

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('/path/to/dir'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('echo hello'))")

curl "http://127.0.0.1:${PORT}/open-terminal?name=my-tab&cwd=${CWD}&cmd=${CMD}"
```

Response:

```json
{ "ok": true, "name": "my-tab", "cwd": "/path/to/dir", "cmd": "echo hello", "color": null, "icon": null }
```

---

### `GET /rename-terminal`

Renames a tracked terminal tab and optionally updates its icon and color. Supports three modes.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name (as passed to `/open-terminal`) |
| `status` | No* | Canonical lifecycle state. The bridge applies the matching codicon label prefix and color automatically. See [status values](#status-values) below. |
| `label` | No* | Full display label override. When combined with `status=`, updates the base label and re-applies the status prefix on top. *Required if neither `status=` nor `quiet=1` is provided.* |
| `color` | No | VS Code ThemeColor ID override. Takes precedence over the status default color. |
| `icon` | No | VS Code ThemeIcon ID. Updates `iconPath` only (does not affect the label codicon). |
| `quiet` | No | `quiet=1` — update only `icon`/`color` (+ status color) without activating the terminal panel. No label change, no flicker. |

**Three modes:**

- **Status mode** (`status=<key>`) — the bridge looks up the canonical codicon + color for the given state, prefixes the label as `$(codicon) baseLabel`, and sets the color. `iconPath` is **never** touched — the identity icon (e.g. `hubot`) stays put. Idempotent: repeated calls with the same status value are no-ops if the label and color are already correct.
- **Quiet mode** (`quiet=1`) — updates `iconPath` and/or color (including the status color when `status=` is combined) via direct property assignment. Zero terminal activation, zero panel flicker. Label is not changed.
- **Legacy mode** (`label=<text>`) — sets the full display label directly. Use for intentional, infrequent renames (e.g. a skill marking a tab `✅ Done`). This briefly activates the target terminal then restores the previously active one; keyboard focus is always preserved.

#### Status values

| `status=` | Codicon | Color |
| --------- | ------- | ----- |
| `working` | `$(loading~spin)` | `terminal.ansiCyan` |
| `needs-input` | `$(bell-dot)` | `terminal.ansiYellow` |
| `idle` | `$(debug-pause)` | `terminal.ansiGreen` |
| `pr-open` | `$(pass-filled)` | `terminal.ansiGreen` |
| `merged` | `$(git-merge)` | `terminal.ansiMagenta` |
| `none` | *(strip prefix)* | *(unchanged)* |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

# Status mode — bridge handles codicon + color (idempotent)
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&status=working"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&status=needs-input"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&status=idle"

# Quiet + status — silent color update, no label change, no panel flicker
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&quiet=1&status=working"

# Legacy label override
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&label=%E2%9C%85%20SOL-69%20done&color=terminal.ansiGreen"

# Update base label while keeping the current status prefix
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&status=working&label=SOL-69%20v2"
```

Response (status mode):

```json
{
  "ok": true,
  "name": "SOL-69",
  "label": "$(loading~spin) SOL-69",
  "baseLabel": "SOL-69",
  "icon": null,
  "color": "terminal.ansiCyan",
  "status": "working"
}
```

Response (idempotent no-op):

```json
{
  "ok": true,
  "name": "SOL-69",
  "label": "$(loading~spin) SOL-69",
  "baseLabel": "SOL-69",
  "icon": null,
  "color": "terminal.ansiCyan",
  "status": "working",
  "noOp": true
}
```

Returns `404` if the terminal is not in the registry (e.g. opened before the last reload).

---

### `GET /close-terminal`

Closes a tracked terminal tab and removes it from the registry.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
curl "http://127.0.0.1:${PORT}/close-terminal?name=my-tab"
```

Response:

```json
{ "ok": true, "name": "my-tab" }
```

---

### `GET /add-folder`

Attaches a path to the current VS Code workspace — the HTTP equivalent of `code --add <path>`. Works from any process without requiring the `code` CLI on `$PATH`. Idempotent: if the path is already a workspace folder, returns `alreadyAttached: true` without error.

After the folder is added, the extension writes `.vscode-bridge-port` into it automatically (via `onDidChangeWorkspaceFolders`), so hook scripts running inside the new folder immediately discover the correct port.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `path` | Yes | Absolute path to attach (URL-encoded) |
| `index` | No | Insertion position. Default: append at end. |
| `name` | No | Display name override for the workspace folder. |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
WORKTREE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('/path/to/worktree'))")

curl "http://127.0.0.1:${PORT}/add-folder?path=${WORKTREE}"
```

Response:

```json
{ "ok": true, "path": "/path/to/worktree", "added": true, "alreadyAttached": false }
```

---

### `GET /remove-folder`

Detaches a workspace folder by path. Idempotent: returns `wasAttached: false` if the folder wasn't in the workspace.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `path` | Yes | Absolute path to detach (URL-encoded) |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
WORKTREE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('/path/to/worktree'))")

curl "http://127.0.0.1:${PORT}/remove-folder?path=${WORKTREE}"
```

Response:

```json
{ "ok": true, "path": "/path/to/worktree", "removed": true, "wasAttached": true }
```

---

## Claude Code hooks

### The pattern

Claude Code fires hook events at key lifecycle points. Each hook runs a shell command; by calling `/rename-terminal` from that command you get live tab updates with zero polling.

**Key principle — icon is identity, color is state:**

- Set `icon=` **once** at `/open-terminal` time to mark what kind of session this tab is (e.g. `icon=hubot` for a Claude sub-agent). This icon persists for the lifetime of the tab.
- Use `color=` in hook calls to communicate the current state. Do **not** pass `icon=` in hook curls — it would overwrite your identity marker on every tool call.

```bash
# Good: icon set at creation, hooks only change color
curl ".../open-terminal?name=SOL-42&icon=hubot&color=terminal.ansiCyan&cmd=..."

# Hook (PreToolUse) — silent color update, no flicker
curl ".../rename-terminal?name=SOL-42&quiet=1&color=terminal.ansiCyan"
```

**Tab-name resolution:** the extension exports `CLAUDE_TAB_NAME=<name>` into the shell when a named terminal is opened. Hook scripts can read `$CLAUDE_TAB_NAME` directly rather than relying on `basename "$PWD"`, which only works when the working directory name matches the tab name.

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
N="${CLAUDE_TAB_NAME:-$(basename "$PWD")}"   # falls back to basename if not set
curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=working" \
  > /dev/null 2>&1 || true
```

### Hook events and what they mean

| Hook | When it fires | Recommended `status=` |
| ---- | ------------- | --------------------- |
| `PreToolUse` | Before every tool call | `working` |
| `Notification` | Claude needs input (permission prompt, question) | `needs-input` |
| `Stop` | Claude's turn is complete | `idle` |

### Recommended state scheme

Use `status=` for all lifecycle hooks — the bridge owns the codicon + color mapping so every caller automatically gets a consistent look:

| `status=` | Tab shows | Color |
| --------- | --------- | ----- |
| `working` | `$(loading~spin) SOL-42` | Cyan |
| `needs-input` | `$(bell-dot) SOL-42` | Yellow |
| `idle` | `$(debug-pause) SOL-42` | Green |

The `hubot` icon set at creation persists as the Claude-session identity marker throughout — `status=` never touches `iconPath`.

`status=` is also **idempotent**: if `PreToolUse` fires twice in a row while already in `working` state, the second call detects that the label and color are unchanged and returns `noOp: true` without activating the terminal panel. This makes it safe to fire on every hook event without accumulating flicker.

### Full settings.json snippet

Copy this into `~/.claude/settings.json` (or merge into your existing `hooks` key):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=\"${CLAUDE_TAB_NAME:-$(basename \"$PWD\")}\"; curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=working\" > /dev/null 2>&1 || true",
            "async": true,
            "timeout": 2
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=\"${CLAUDE_TAB_NAME:-$(basename \"$PWD\")}\"; curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=needs-input\" > /dev/null 2>&1 || true",
            "async": true,
            "timeout": 2
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=\"${CLAUDE_TAB_NAME:-$(basename \"$PWD\")}\"; curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=idle\" > /dev/null 2>&1 || true",
            "async": true,
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

> **Why `async: true`?** Hook commands run synchronously by default and block Claude's response. `async: true` fires the curl in the background so it adds no latency.
>
> **Why not OSC escape sequences?** Claude Code hooks run as detached subprocesses without a controlling TTY, so writing `\033]0;...\007` to `/dev/tty` fails silently. Calling this extension's HTTP API is the reliable alternative.
>
> **Why `status=` instead of `quiet=1&color=`?** `status=` is idempotent (no-op on repeat) and self-documenting — callers say *what* the state is, not *how* to render it. If you add new terminals or change the color scheme, update `STATUS_MAP` in the extension once and every caller benefits automatically.

### Extending to other hook types

Claude Code supports additional hook events you can wire the same way:

```bash
# Template — swap in any hook name and status
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
N="${CLAUDE_TAB_NAME:-$(basename "$PWD")}"
curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=working" \
  > /dev/null 2>&1 || true
```

Use `matcher` to scope a hook to a specific tool name (e.g. `"matcher": "Bash"` fires only when Claude calls Bash):

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=\"${CLAUDE_TAB_NAME:-$(basename \"$PWD\")}\"; curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=working\" > /dev/null 2>&1 || true",
          "async": true,
          "timeout": 2
        }
      ]
    }
  ]
}
```

---

## Automated worktree setup

Open a named terminal for a git worktree, attach the worktree to the VS Code workspace, and start Claude automatically — all via the HTTP bridge, no `code` CLI required:

```bash
ISSUE="SOL-42"
WORKTREE="$HOME/worktrees/my-repo/$ISSUE"

git worktree add "$WORKTREE" -b "$ISSUE"

PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$WORKTREE'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"claude '/linear-process $ISSUE'\"))")

# Attach the worktree folder to the VS Code workspace (writes .vscode-bridge-port there too)
curl -s "http://127.0.0.1:${PORT}/add-folder?path=${CWD}"

# Open the terminal (focus is preserved in the editor by default)
curl -s "http://127.0.0.1:${PORT}/open-terminal?name=${ISSUE}&cwd=${CWD}&cmd=${CMD}&icon=hubot&color=terminal.ansiCyan"
```

The terminal is registered under `SOL-42`, so the Claude Code hooks above rename it automatically, and `/close-terminal?name=SOL-42` closes it when the work is done. When the worktree is cleaned up, call `/remove-folder` to detach it from the workspace.

---

## Common patterns

### Pattern 1: Monitor multiple long-running processes

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

curl "http://127.0.0.1:${PORT}/open-terminal?name=build&cmd=npm%20run%20build"

# From your build script:
curl "http://127.0.0.1:${PORT}/rename-terminal?name=build&label=build%20%5B%E2%9A%99%EF%B8%8F%20compiling%5D"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=build&label=build%20%5B%E2%9C%85%20done%5D"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=build&label=build%20%5B%E2%9D%8C%20failed%5D"
```

### Pattern 2: Shell hooks for any interactive process

Use zsh `preexec`/`precmd` hooks in `~/.zshrc` to update the tab whenever a command runs:

```zsh
function preexec() {
  PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
  N=$(basename "$PWD")
  curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=$N%20%5B%E2%9A%99%EF%B8%8F%20working%5D" > /dev/null 2>&1 &
}

function precmd() {
  PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
  N=$(basename "$PWD")
  curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=$N%20%5B%E2%8F%B8%20idle%5D" > /dev/null 2>&1 &
}
```

> **Note:** This covers shell-level commands only. For finer-grained updates inside a long-running process (like an AI agent), use tool-level hooks instead.

### Pattern 3: CI / deployment status board

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

for env in staging prod; do
  curl "http://127.0.0.1:${PORT}/open-terminal?name=deploy-$env"
done

# From your deploy script:
curl "http://127.0.0.1:${PORT}/rename-terminal?name=deploy-staging&label=staging%20%5B%F0%9F%9F%A1%20deploying%5D"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=deploy-staging&label=staging%20%5B%E2%9C%85%20live%5D"
```

### Pattern 4: Issue/task-scoped terminals

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

for issue in TASK-1 TASK-2 TASK-3; do
  CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"$HOME/work/$issue\"))")
  curl "http://127.0.0.1:${PORT}/open-terminal?name=$issue&cwd=$CWD"
done

# Close when done
curl "http://127.0.0.1:${PORT}/close-terminal?name=TASK-1"
```

---

## After a VS Code reload

The extension re-indexes automatically. When the window is focused after a reload it scans all open terminals against persisted metadata and active git worktrees, re-linking any match. You can also call `/reindex` explicitly from a script to force a scan without waiting for window focus.

## Security

The server binds to `127.0.0.1` only — it is **not** accessible from other machines on the network. It has no authentication because it controls only your local VS Code instance.

## License

MIT
