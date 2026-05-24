# VS Code Terminal Bridge

A tiny VS Code extension that exposes a local HTTP API for opening named terminal tabs programmatically — from bash scripts, shell tools, or any process that can make an HTTP request.

Built to solve a real problem: VS Code extensions and external scripts **cannot** reliably open terminals using AppleScript, keystrokes, or CLI flags. This extension uses the native `vscode.window.createTerminal` API, exposed via a local-only HTTP server.

## How it works

On activation, the extension starts an HTTP server on `127.0.0.1:31415`. Any process on the same machine can `curl` it to open a terminal tab.

## Installation

### Option A: Manual (clone and drop in)
```bash
git clone https://github.com/solcarty/vscode-terminal-bridge \
  ~/.vscode/extensions/sdo.terminal-bridge-0.0.1

# For VS Code Insiders:
git clone https://github.com/solcarty/vscode-terminal-bridge \
  ~/.vscode-insiders/extensions/sdo.terminal-bridge-0.0.1
```
Then reload VS Code (`Cmd+Shift+P` → **Developer: Reload Window**).

### Option B: Install from VSIX
Download the latest `.vsix` from [Releases](../../releases) and run:
```bash
code --install-extension terminal-bridge-*.vsix
```

## API

### `GET /ping`
Health check. Returns `pong` if the extension is running.

```bash
curl http://127.0.0.1:31415/ping
```

### `GET /open-terminal`
Opens a named terminal tab and optionally runs a command in it.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | No | Terminal tab label |
| `cwd` | No | Working directory (URL-encoded) |
| `cmd` | No | Shell command to run (URL-encoded) |

```bash
CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('/path/to/dir'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"echo hello\"))")

curl "http://127.0.0.1:31415/open-terminal?name=my-tab&cwd=${CWD}&cmd=${CMD}"
```

Response:
```json
{ "ok": true, "name": "my-tab", "cwd": "/path/to/dir", "cmd": "echo hello" }
```

## Use case: automated worktree setup

This was built for a workflow where `/worktree-start <issue-id>` (a Claude Code skill) creates a git worktree, adds it to the VS Code workspace, and opens a named terminal running `claude '/linear-process <issue-id>'` — all without any user interaction.

```bash
# In your /worktree-start script:
WORKTREE="/path/to/worktrees/my-issue"
CWD=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$WORKTREE'))")
CMD=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"claude '/linear-process MY-ISSUE'\"))")

curl -s "http://127.0.0.1:31415/open-terminal?name=MY-ISSUE&cwd=${CWD}&cmd=${CMD}"
```

## Security

The server binds to `127.0.0.1` only — it is **not** accessible from other machines on the network. It has no authentication because it controls only your local VS Code instance.

## License

MIT
