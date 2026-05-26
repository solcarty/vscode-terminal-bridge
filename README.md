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

### Option A: Manual (clone and drop in)

```bash
# VS Code stable:
git clone https://github.com/solcarty/vscode-terminal-bridge \
  ~/.vscode/extensions/sdo.terminal-bridge-0.0.1

# VS Code Insiders:
git clone https://github.com/solcarty/vscode-terminal-bridge \
  ~/.vscode-insiders/extensions/sdo.terminal-bridge-0.0.1
```

Then reload VS Code (`Cmd+Shift+P` → **Developer: Reload Window**).

### Option B: Install from VSIX

Download the latest `.vsix` from [Releases](../../releases) and run:

```bash
code --install-extension terminal-bridge-*.vsix
```

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
| `icon` | No | Tab icon — VS Code ThemeIcon ID (e.g. `check`, `error`, `sync~spin`) |

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

Renames a tracked terminal tab and optionally updates its icon and color. Uses VS Code's `workbench.action.terminal.renameWithArg` command with `preserveFocus: true` — **keyboard focus is never stolen** from the editor or active terminal.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name (as passed to `/open-terminal`) |
| `label` | Yes | New display label for the tab |
| `icon` | No | VS Code ThemeIcon ID (e.g. `sync~spin`, `bell`, `check`) |
| `color` | No | VS Code ThemeColor ID (e.g. `terminal.ansiCyan`, `terminal.ansiYellow`, `terminal.ansiGreen`) |

**Recommended label format:** put status first so it's always visible regardless of tab width:

```text
🤖 ⚙️ SOL-69    ← working
🤖 🛎 SOL-69    ← needs input
🤖 ⏸ SOL-69    ← idle
```

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

# Working
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&label=%F0%9F%A4%96%20%E2%9A%99%EF%B8%8F%20SOL-69&icon=sync~spin&color=terminal.ansiCyan"

# Needs input
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&label=%F0%9F%A4%96%20%F0%9F%9B%8E%20SOL-69&icon=bell&color=terminal.ansiYellow"

# Idle
curl "http://127.0.0.1:${PORT}/rename-terminal?name=SOL-69&label=%F0%9F%A4%96%20%E2%8F%B8%20SOL-69&icon=check&color=terminal.ansiGreen"
```

Response:

```json
{ "ok": true, "name": "SOL-69", "label": "🤖 ⚙️ SOL-69", "icon": "sync~spin", "color": "terminal.ansiCyan" }
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

## Claude Code hooks

### The pattern

Claude Code fires hook events at key lifecycle points. Each hook runs a shell command; by calling `/rename-terminal` from that command you get live tab-label updates with zero polling.

The core pattern is always the same — read the port, get the terminal name from `$PWD`, fire the curl:

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
N=$(basename "$PWD")
curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=<LABEL>&icon=<ICON>&color=<COLOR>" \
  > /dev/null 2>&1 || true
```

`basename "$PWD"` works because worktree directories are named after the issue ID (e.g. `SOL-42`), which matches the `name` passed to `/open-terminal` when the terminal was created.

To extend this to your own use case, change the `label`, `icon`, and `color` values. The full list of valid ThemeIcon IDs is in the [VS Code icon listing](https://code.visualstudio.com/api/references/icons-in-labels); ThemeColor IDs for terminals are `terminal.ansi{Color}`.

### Hook events and what they mean

| Hook | When it fires | Good for |
| ---- | ------------- | -------- |
| `PreToolUse` | Before every tool call | Show "working" spinner |
| `Notification` | Claude needs input (permission prompt, question) | Show "waiting" indicator |
| `Stop` | Claude's turn is complete | Show "idle / done" state |

### Recommended label scheme

Put status **first** so it's readable even when tabs are narrow:

| State | Label | Icon | Color |
| ----- | ----- | ---- | ----- |
| Working | `🤖 ⚙️ SOL-42` | `sync~spin` | `terminal.ansiCyan` |
| Waiting on you | `🤖 🛎 SOL-42` | `bell` | `terminal.ansiYellow` |
| Idle / done | `🤖 ⏸ SOL-42` | `check` | `terminal.ansiGreen` |

The `🤖` prefix marks the tab as a Claude sub-agent at a glance. `Notification` is the load-bearing hook for multi-session orchestration — it's how you tell "finished" from "blocked on you" without switching to each tab.

### Full settings.json snippet

Copy this into `~/.claude/settings.json` (or merge into your existing `hooks` key). Adjust labels, icons, and colors to suit your workflow:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=$(basename \"$PWD\"); curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=%F0%9F%A4%96%20%E2%9A%99%EF%B8%8F%20$N&icon=sync~spin&color=terminal.ansiCyan\" > /dev/null 2>&1 || true",
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
            "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=$(basename \"$PWD\"); curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=%F0%9F%A4%96%20%F0%9F%9B%8E%20$N&icon=bell&color=terminal.ansiYellow\" > /dev/null 2>&1 || true",
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
            "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=$(basename \"$PWD\"); curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=%F0%9F%A4%96%20%E2%8F%B8%20$N&icon=check&color=terminal.ansiGreen\" > /dev/null 2>&1 || true",
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

> **Why not OSC escape sequences?** Claude Code hooks run as detached subprocesses without a controlling TTY, so writing `\033]0;...\007` to `/dev/tty` fails silently. Calling this extension's HTTP API is the reliable alternative.

### Extending to other hook types

Claude Code supports additional hook events you can wire the same way:

```bash
# Template — swap in any hook name and label
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
N=$(basename "$PWD")
LABEL="<your label here>"
ICON="<themeicon-id>"
COLOR="terminal.ansi<Color>"
curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=${LABEL}&icon=${ICON}&color=${COLOR}" \
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
          "command": "PORT=$(cat \"$PWD/.vscode-bridge-port\" 2>/dev/null || echo 31415); N=$(basename \"$PWD\"); curl -s \"http://127.0.0.1:${PORT}/rename-terminal?name=$N&label=%F0%9F%90%9A%20$N&icon=terminal&color=terminal.ansiMagenta\" > /dev/null 2>&1 || true",
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

Open a named terminal for a git worktree and start Claude automatically. The port is read from `.vscode-bridge-port` in the repo root so the terminal always opens in the correct VS Code window:

```bash
ISSUE="SOL-42"
WORKTREE="$HOME/worktrees/my-repo/$ISSUE"

git worktree add "$WORKTREE" -b "$ISSUE"

PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$WORKTREE'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"claude '/linear-process $ISSUE'\"))")

curl -s "http://127.0.0.1:${PORT}/open-terminal?name=${ISSUE}&cwd=${CWD}&cmd=${CMD}&icon=hubot&color=terminal.ansiCyan"
```

The terminal is registered under `SOL-42`, so the Claude Code hooks above rename it automatically, and `/close-terminal?name=SOL-42` closes it when the work is done.

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
