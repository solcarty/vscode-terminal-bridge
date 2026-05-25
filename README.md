# VS Code Terminal Bridge

A tiny VS Code extension that exposes a local HTTP API for managing terminal tabs programmatically — open, rename, and close named terminals from bash scripts, shell tools, or any process that can make an HTTP request.

Built to solve a real problem: VS Code extensions and external scripts **cannot** reliably open terminals using AppleScript, keystrokes, or CLI flags. This extension uses the native `vscode.window.createTerminal` API, exposed via a local-only HTTP server.

## How it works

On activation, the extension starts an HTTP server on `127.0.0.1:31415`. Terminals opened via `/open-terminal` are registered in an internal Map (`name → terminal instance`). This registry survives tab renames and lets you target the right terminal for later `/rename-terminal` and `/close-terminal` calls.

> **Important:** Only terminals opened via `/open-terminal` with a `name` are tracked. Terminals opened manually in VS Code are not in the registry.

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

For the best experience, set your terminal tab title format to show both the dynamic status and the folder name:

**Settings → Terminal › Integrated › Tabs: Title** (or edit `settings.json`):

```json
"terminal.integrated.tabs.title": "${sequence}${separator}${rootWorkspaceFolderName}"
```

This gives you:
- `${rootWorkspaceFolderName}` — always shows the workspace folder (e.g. `SOL-60`) on the right
- `${sequence}` — shows any OSC title sequences emitted by the shell on the left
- When a terminal is renamed via `/rename-terminal`, the static label overrides this format entirely

## API

### `GET /ping`

Health check. Returns `pong` if the extension is running.

```bash
curl http://127.0.0.1:31415/ping
```

---

### `GET /open-terminal`

Opens a named terminal tab and optionally runs a command in it.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | No | Terminal tab label and registry key |
| `cwd` | No | Working directory (URL-encoded path) |
| `cmd` | No | Shell command to run on open (URL-encoded) |
| `color` | No | Tab color — VS Code ThemeColor ID (e.g. `terminal.ansiGreen`). Reserved for future status indicators. |
| `icon` | No | Tab icon — VS Code ThemeIcon ID (e.g. `check`, `error`, `sync~spin`). Reserved for future status indicators. |

```bash
CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('/path/to/dir'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('echo hello'))")

curl "http://127.0.0.1:31415/open-terminal?name=my-tab&cwd=${CWD}&cmd=${CMD}"
```

Response:
```json
{ "ok": true, "name": "my-tab", "cwd": "/path/to/dir", "cmd": "echo hello", "color": null, "icon": null }
```

---

### `GET /rename-terminal`

Renames a tracked terminal tab by its registry name. Uses VS Code's `workbench.action.terminal.renameWithArg` command, which sets a **static label** that persists regardless of shell title sequences.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Registry name (as passed to `/open-terminal`) |
| `label` | Yes | New display label for the tab |

```bash
curl "http://127.0.0.1:31415/rename-terminal?name=my-tab&label=my-tab%20%5B%E2%9A%99%EF%B8%8F%20working%5D"
# Sets tab to: my-tab [⚙️ working]
```

Response:
```json
{ "ok": true, "name": "my-tab", "label": "my-tab [⚙️ working]" }
```

Returns `404` if the terminal is not in the registry (e.g. opened before the last reload).

---

### `GET /close-terminal`

Closes a tracked terminal tab and removes it from the registry.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Registry name |

```bash
curl "http://127.0.0.1:31415/close-terminal?name=my-tab"
```

Response:
```json
{ "ok": true, "name": "my-tab" }
```

---

## Claude Code integration

### Live status labels via hooks

Add these hooks to `~/.claude/settings.json` to automatically rename terminal tabs as Claude works:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "N=$(basename $PWD); curl -s \"http://127.0.0.1:31415/rename-terminal?name=$N&label=$N%20%5B%E2%9A%99%EF%B8%8F%20working%5D\" > /dev/null 2>&1 || true",
            "async": true
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
            "command": "N=$(basename $PWD); curl -s \"http://127.0.0.1:31415/rename-terminal?name=$N&label=$N%20%5B%E2%8F%B8%20idle%5D\" > /dev/null 2>&1 || true",
            "async": true
          }
        ]
      }
    ]
  }
}
```

This renames the tab to `SOL-60 [⚙️ working]` when Claude uses a tool, and `SOL-60 [⏸ idle]` when it stops — letting you monitor multiple Claude sessions across tabs at a glance.

> **Why `async: true`?** Hook commands run synchronously by default and block Claude's response. `async: true` fires the curl in the background so it doesn't add latency.

> **Why not OSC escape sequences?** Claude Code hooks run as detached subprocesses without a controlling TTY, so writing `\033]0;...\007` to `/dev/tty` fails. Calling this extension's HTTP API is the reliable alternative.

### Automated worktree setup

Open a named terminal for a git worktree and start Claude automatically:

```bash
ISSUE="SOL-42"
WORKTREE="$HOME/worktrees/my-repo/$ISSUE"

# Create worktree first, then open terminal
git worktree add "$WORKTREE" -b "$ISSUE"

CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$WORKTREE'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"claude '/linear-process $ISSUE'\"))")

curl -s "http://127.0.0.1:31415/open-terminal?name=${ISSUE}&cwd=${CWD}&cmd=${CMD}"
```

The terminal is registered under `SOL-42`, so the hooks above will rename it correctly, and `/close-terminal?name=SOL-42` will close it when the work is done.

## Common patterns

### Pattern 1: Monitor multiple long-running processes

Open a named terminal for each process, then rename it as status changes:

```bash
# Start a build
curl "http://127.0.0.1:31415/open-terminal?name=build&cmd=npm%20run%20build"

# From your build script, update the label as it progresses:
curl "http://127.0.0.1:31415/rename-terminal?name=build&label=build%20%5B%E2%9A%99%EF%B8%8F%20compiling%5D"
curl "http://127.0.0.1:31415/rename-terminal?name=build&label=build%20%5B%E2%9C%85%20done%5D"
curl "http://127.0.0.1:31415/rename-terminal?name=build&label=build%20%5B%E2%9D%8C%20failed%5D"
```

### Pattern 2: Shell hooks for any interactive process

Use zsh `preexec`/`precmd` hooks in `~/.zshrc` to update the tab whenever a command runs — no special tool integration needed:

```zsh
function preexec() {
  N=$(basename "$PWD")
  curl -s "http://127.0.0.1:31415/rename-terminal?name=$N&label=$N%20%5B%E2%9A%99%EF%B8%8F%20working%5D" > /dev/null 2>&1 &
}
function precmd() {
  N=$(basename "$PWD")
  curl -s "http://127.0.0.1:31415/rename-terminal?name=$N&label=$N%20%5B%E2%8F%B8%20idle%5D" > /dev/null 2>&1 &
}
```

This works for any terminal opened via `/open-terminal` — the tab renames whenever a shell command starts or finishes.

> **Note:** This approach only covers shell-level commands. If a process (like an AI agent) runs internally without spawning new shell commands, the shell hooks won't fire during its execution — use tool-level hooks (see Claude Code section) for finer-grained updates.

### Pattern 3: CI / deployment status board

Open a terminal per environment and rename as deploys complete:

```bash
for env in staging prod; do
  curl "http://127.0.0.1:31415/open-terminal?name=deploy-$env"
done

# Later, from your deploy script:
curl "http://127.0.0.1:31415/rename-terminal?name=deploy-staging&label=staging%20%5B%F0%9F%9F%A1%20deploying%5D"
curl "http://127.0.0.1:31415/rename-terminal?name=deploy-staging&label=staging%20%5B%E2%9C%85%20live%5D"
```

### Pattern 4: Issue/task-scoped terminals

Open one terminal per task, named after the task ID. The tab list becomes a live task board:

```bash
# Open a terminal for each task you're working on
for issue in TASK-1 TASK-2 TASK-3; do
  CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"$HOME/work/$issue\"))")
  curl "http://127.0.0.1:31415/open-terminal?name=$issue&cwd=$CWD"
done

# Close when done
curl "http://127.0.0.1:31415/close-terminal?name=TASK-1"
```

---

## After a VS Code reload

The registry is in-memory and resets on every **Developer: Reload Window**. Terminals opened before a reload are no longer tracked — `/rename-terminal` and `/close-terminal` will return `404` for them. Re-open them via `/open-terminal` to re-register.

## Security

The server binds to `127.0.0.1` only — it is **not** accessible from other machines on the network. It has no authentication because it controls only your local VS Code instance.

## License

MIT
