# VS Code Terminal Bridge

A tiny VS Code extension that exposes a local HTTP API for managing terminal tabs programmatically — open, rename, and close named terminals from bash scripts, shell tools, or any process that can make an HTTP request.

Built to solve a real problem: VS Code extensions and external scripts **cannot** reliably open terminals using AppleScript, keystrokes, or CLI flags. This extension uses the native `vscode.window.createTerminal` API, exposed via a local-only HTTP server.

## How it works

On activation, the extension starts an HTTP server on `127.0.0.1`. It tries port **31415** first; if that port is already taken (e.g. a second VS Code window is open), it increments until it finds a free port (`31416`, `31417`, …), giving up after 32 attempts.
(Before v0.19.0 the retry re-tried `31416` forever, so a **third** window never bound at all and never wrote a port file — its shells fell back to another window's bridge.)

Once bound, the extension writes the active port to a `.vscode-bridge-port` file in **every workspace folder**. Scripts discover their window's port by reading this file from the repo root — no hardcoded port, no guessing which window is which.

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
```

> **Add `.vscode-bridge-port` to `.gitignore`** — it's machine-local state and should not be committed.

Terminals opened via `/open-terminal` are registered in an internal Map (`name → terminal instance`). Terminal metadata (`name`, `cwd`, `label`, `color`) is persisted to VS Code workspace state. On every window activation the extension scans all open terminals and re-links any that match a persisted entry or a live `git worktree list` path — so `/rename-terminal` and `/close-terminal` keep working after a **Developer: Reload Window** without manual intervention.

> **Important:** Only terminals opened via `/open-terminal` with a `name` are tracked. Terminals opened manually in VS Code are not in the registry.

## Multi-window setup

When two VS Code windows are open on **different** folders, each gets its own bridge on a different port:

| Window | Port | `.vscode-bridge-port` |
| ------ | ---- | --------------------- |
| First window to activate | `31415` | `31415` |
| Second window | `31416` | `31416` |

Scripts running inside a VS Code terminal read `.vscode-bridge-port` from their working directory, so they always talk to the bridge in **their own window** — no configuration needed.

**Caveat — same workspace open in multiple windows:** if the *same* multi-root workspace (e.g. one `.code-workspace` file listing several worktree folders) is opened in more than one window, every window's extension instance writes `.vscode-bridge-port` into the *same* folders — whichever window (re)activates last wins, for every folder, in every other window too. A terminal opened via `/open-terminal` isn't affected: the extension also exports `VSCODE_BRIDGE_PORT` (pinned to the exact port of the window that spawned it) into every terminal it creates, and `bridgectl.sh`/`vscode-bridge.sh` prefer that env var — inherited by any subshells/hooks running inside that tab — over the shared, racy port file. A plain terminal you open by hand (not via `/open-terminal`) still falls back to the port file, so it can end up talking to a different window's bridge in this setup.

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

## Bash client (recommended over raw curl)

The extension bundles a small bash client (`bin/vscode-bridge.sh` + `bin/bridgectl.sh`) and writes it to `~/.vscode-terminal-bridge/bin/` on every activation — a fixed, repo-independent path that stays version-matched to whatever extension version is installed. Point your scripts/skills there instead of vendoring a copy per repo; bumping the extension re-syncs every consumer automatically.

```bash
# one command per action — easy to cover with a single permission allow-rule
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open   <name> <cwd> [cmd] [icon] [color] [--cmd-file=<path>] [--node=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh status <name> <state>   # working|idle|needs-input|pr-open|merged|...
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh close  <name>   # disposes the tab AND removes its tracked row
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh forget <name>   # removes the tracked row only, never touches a process
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send   <name> <text>|--text-file=<path> [--no-submit] [--force] [--mode=...]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh list
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh bg-task {start|end|clear} [--name=<name>]   # outstanding background work
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh note set <text>|--text-file=<path>          # publish a handoff
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh note get <name>                             # read one back
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh sweep
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh ping
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status <status> [--name=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend {cline|claude} [--dir=<repo>] [--force]
```

Or source the functions directly:

```bash
. ~/.vscode-terminal-bridge/bin/vscode-bridge.sh
bridge_open "$NAME" "$CWD" "$CMD"
bridge_status "$NAME" working
```

Both handle port discovery (walking up for `.vscode-bridge-port`, preferring `$VSCODE_BRIDGE_PORT` when set — see [Multi-window setup](#multi-window-setup)), falling back to `~/.vscode-terminal-bridge/port` when the caller's cwd sits outside every workspace folder. `bridge_open` and `bridge_status` return a non-zero exit code and print an error to stderr on real failures (bridge unreachable, malformed args, bridge-reported error) rather than swallowing them. Source: `bin/` in this repo.

**Mutating vs. query commands (v0.16.0+).** `open`/`close`/`status`/`rename`/`sweep` no-op silently when the bridge isn't reachable — hooks call them outside VS Code and shouldn't fail under `set -e`. **`list` is different:** it prints `{"ok":false,"reason":"bridge-unreachable"}` and exits non-zero, because an empty result with exit 0 is indistinguishable from "bridge is up, tracking zero terminals". Anything polling `list` to decide whether a terminal is still alive would read that silence as fact and conclude a dead tab was simply an empty list. **If you consume `list`, check the exit code** rather than treating empty output as "no terminals".

`send` (v0.17.0+) follows `list`, not the mutating commands: a message you believe was delivered but wasn't is worse than a loud failure, so an unreachable bridge, an unknown name, or a dead terminal all exit non-zero with a JSON reason.

## Workspace requirement

The `.vscode-bridge-port` file is written to each **workspace folder** — a path that VS Code has open as a root in the Explorer. If you open a loose file or a folder that isn't part of a workspace, no per-folder port file is written there.

Since v0.16.0 the extension also writes the active port to `~/.vscode-terminal-bridge/port`, which the shell helpers consult when walking up from `$PWD` finds nothing. This matters for **agent-spawned shells**: they inherit neither `$TERM_PROGRAM` nor `$VSCODE_BRIDGE_PORT`, so the walk-up was previously their only discovery path — and a shell that had `cd`'d to `/tmp` or a scratch directory would conclude "no bridge" while the server was running perfectly well. A caller's working directory is not evidence about whether a local HTTP server exists. Port discovery still falls back to `31415` if neither file is present.

For the port file to work correctly, your repo root must be open as a workspace folder (the normal case when you open a folder with `code .` or `code-insiders .`). When you add worktrees with `/add-folder`, the extension writes the port file there too, so hooks and scripts running inside a worktree terminal always find the right port.

## VS Code title format (recommended)

This setting only matters for terminals **not** managed by the bridge — any tab opened or renamed via `/open-terminal` / `/rename-terminal` gets a static label (with the `$(codicon)` status prefix baked in, see [status values](#status-values)) that overrides whatever title format VS Code would otherwise compute. For everything else — terminals you open manually, or before this extension renames them — this format gives you a useful default: the live shell title on the left, the workspace folder name on the right.

**Settings → Terminal › Integrated › Tabs: Title** (or edit `settings.json`):

```json
"terminal.integrated.tabs.title": "${sequence}${separator}${rootWorkspaceFolderName}"
```

This gives you:

- `${rootWorkspaceFolderName}` — always shows the workspace folder name on the right
- `${sequence}` — shows any OSC title sequences emitted by the shell on the left
- Once a terminal is renamed via `/rename-terminal` (e.g. with `status=working`), its static label replaces this computed format entirely — that's how bridge-managed status icons actually show up in the tab

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
    "/Users/you/worktrees/my-repo/my-task"
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
| `cmdFile` | No | Path to a file containing the command to run instead of `cmd`. Use this for long or quote-heavy commands (e.g. a multi-hundred-character agent kickoff prompt) — threading them through argv risks breaking across shell-quoting at the call site, URL-encoding, and re-parsing by the terminal's shell. Ignored if `cmd` is also set. |
| `color` | No | Tab color — VS Code ThemeColor ID (e.g. `terminal.ansiGreen`) |
| `icon` | No | Tab icon — VS Code ThemeIcon ID (e.g. `hubot`, `check`, `error`). Set once at creation to mark the terminal's identity. |
| `focus` | No | Set `focus=1` to steal keyboard focus. Default: focus is **preserved** (the editor keeps focus). |
| `node` | No | Offload `cmd` to a worker node registered in `~/.vscode-terminal-bridge/nodes.json` instead of running it in this window. See [Remote jobs](#remote-jobs). |
| `ref` | No | Git ref the remote job's worktree is cut from. Only used with `node=`. Default: `main`. |

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

The bundled `bridgectl.sh open` client checks this response and returns a non-zero exit code (printing the error to stderr) if the bridge couldn't be reached or reported failure — it no longer swallows every error with a blind `|| true`.

**Large or quote-heavy commands:** write the command to a file and pass `--cmd-file` instead of a positional `cmd`:

```bash
echo 'claude "…a very long, quote-heavy kickoff prompt…"' > /tmp/kickoff.sh
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open my-task /path/to/worktree --cmd-file=/tmp/kickoff.sh
```

---

### `GET /list`

Read-path companion to `/open-terminal`, `/close-terminal`, and `/rename-terminal` (all write-only) — lets a caller check whether a spawn actually landed and what state it's tracked in, instead of guessing from silence.

```bash
curl "http://127.0.0.1:${PORT}/list"
```

```json
{
  "ok": true,
  "now": "2026-08-05T11:52:07.401Z",
  "terminals": [
    {
      "name": "my-task", "cwd": "/path/to/dir", "label": "my-task",
      "status": "working", "node": null, "jobId": null,
      "pid": 12345, "live": true, "pidAlive": true,
      "createdAt": "2026-08-05T09:14:02.881Z",
      "updatedAt": "2026-08-05T11:52:04.019Z",
      "statusChangedAt": "2026-08-05T09:14:11.226Z",
      "lastHeartbeatAt": "2026-08-05T11:52:04.019Z",
      "lastSendAt": "2026-08-05T11:51:58.004Z",
      "pendingTasks": 1, "bgTask": true,
      "bgTaskStartedAt": "2026-08-05T11:44:30.007Z",
      "displayStatus": "bg-task",
      "noteUpdatedAt": "2026-08-05T11:50:12.771Z",
      "noteBytes": 128, "noteTruncated": false
    }
  ]
}
```

#### Timestamps and liveness (v0.18.0+)

Status alone answers "what state is this in". The question an orchestrator actually has is *does this need me right now* — and a terminal at `needs-input` for two minutes and one at `needs-input` for two hours are the same row without a clock.

| Field | Moves when |
|---|---|
| `createdAt` | Terminal first tracked. Never advances afterwards. |
| `updatedAt` | Any metadata write — status, rename, pid, color. |
| `statusChangedAt` | The status **value** changes. A `PreToolUse` hook firing `status=working` every few seconds does *not* reset it, or "how long has this been working" becomes unanswerable. |
| `lastHeartbeatAt` | **Any** `/rename-terminal` call lands, including the idempotent no-ops. |
| `lastSendAt` | A `/send-text` call **submits** text into this terminal (v0.20.0+). Staged text (`submit=0`) and refused sends don't stamp. |
| `bgTaskStartedAt` | `pendingTasks` goes from 0 to 1 (v0.21.0+). Cleared when the count returns to 0, so it can't outlive the work it described. |
| `noteUpdatedAt` | A worker publishes a note via `/set-note` (v0.22.0+). The **body is not in `/list`** — fetch it from [`/note`](#get-set-note--get-note--get-clear-note) for the entries whose timestamp moved. |

`pendingTasks` / `bgTask` / `displayStatus` (v0.21.0+) carry the background-work dimension — see [`/bg-task`](#get-bg-task) for why that is separate from `status`. `status` remains the raw turn state; `displayStatus` is what the tab renders.

`now` is the bridge's clock at response time, so callers compute ages against it rather than their own.

**Why `lastHeartbeatAt` is separate from `statusChangedAt`.** Status is *self-reported*: it says what the agent last announced, not what's true now. A subagent spinning on no-op calls and a subagent making real progress both report `working` indefinitely. `live` doesn't close the gap either — it only asserts the VS Code terminal object exists, which stays true around a crashed or hung process. The heartbeat is the independent signal: it advances on the repeat hook calls that sustained work generates, so `working` with a 40-minute-old heartbeat is a wedged agent, not a busy one.

**The bridge never derives status from staleness.** No auto-flip to `error` after N minutes — a build legitimately runs quiet for 20. Only the caller knows where its threshold sits, so this reports facts and stops there.

**`pidAlive` is narrower than it looks.** The tracked pid is the terminal's *shell*, not the agent inside it, and a crashed `claude` usually drops back to a live shell prompt — so `pidAlive` stays `true`. It catches the tab-is-gone case cheaply; `lastHeartbeatAt` is what distinguishes wedged from working. `null` means no pid was ever recorded.

**`lastSendAt` is how you confirm a send was picked up (v0.20.0+).** `/send-text` returning 200 means the text was *written* to the terminal, not read — `sendText` queues in the buffer. Comparing the two timestamps answers what the exit code can't:

| Observation | Means |
|---|---|
| `lastHeartbeatAt` < `lastSendAt` | Delivered, not yet picked up |
| `lastHeartbeatAt` > `lastSendAt` | Picked up — the agent has done something since your text landed |
| `lastSendAt` is `null` | Nothing was ever sent |

Watching for a status *transition* instead doesn't work: hooks fire on tool calls, so an agent that reasons for a while before acting still reads `needs-input` long after your text landed — and a transition that does happen can't be attributed to your send rather than to the agent acting on its own. A heartbeat *after* your send is attributable in a way a bare status change never is.

**Entries predating a field's release report `null`** rather than a fabricated value — the four v0.18.0 timestamps on older entries, and `lastSendAt` on any terminal that hasn't been sent to. Treat `null` as unknown, not as zero.

Or via the bundled client: `bash ~/.vscode-terminal-bridge/bin/bridgectl.sh list`.

---

### `GET /send-text`

*v0.17.0+.* Injects text into an **already-running** tracked terminal. `/open-terminal`'s `cmd` only fires at spawn, so before this the only way to get a message into a live agent session was a close + re-open — which restarts it and loses its in-memory context. This delivers to the session that's already there.

| Param | Default | Meaning |
|-------|---------|---------|
| `name` | — | Tracked terminal name (required) |
| `text` | — | Inline payload |
| `textFile` | — | Absolute path to a file whose **contents** are injected |
| `submit` | `1` | `0` stages the text without sending a newline |
| `force` | `0` | `1` sends even when the terminal is at an interactive prompt |
| `mode` | `auto` | `auto` \| `paste` \| `literal` \| `join` |

```bash
# Short nudge
curl -G "http://127.0.0.1:${PORT}/send-text" \
  --data-urlencode "name=my-task" \
  --data-urlencode "text=your branch was rebased, re-run /pre-pr"

# Multi-paragraph message — write it to a file first
curl -G "http://127.0.0.1:${PORT}/send-text" \
  --data-urlencode "name=my-task" --data-urlencode "textFile=/tmp/msg.txt"
```

```json
{ "ok": true, "name": "my-task", "status": "working", "submitted": true, "mode": "paste", "bytes": 412 }
```

**`textFile` is not `/open-terminal`'s `cmdFile`.** `cmdFile` turns into `bash <file>` — it *runs* the file, which is meaningful against a fresh shell prompt and meaningless against a live TUI. `textFile` reads the file and injects its contents as typed text. Use it for anything multi-line, quote-heavy, or long enough to strain an inline GET URL. Trailing newlines are stripped so the payload doesn't submit itself before `submit` does.

**Newlines and `mode`.** VS Code's `sendText` writes text as though typed, so in a TUI every embedded `\n` acts as Enter — a three-paragraph message would submit paragraph 1 as a complete turn and the rest as separate, contextless ones. So multi-line payloads are wrapped in bracketed paste (`ESC[200~ … ESC[201~`) and submitted once, the same mechanism that makes pasting multi-line text by hand work. Single-line payloads skip the wrapper entirely, so there are no escape sequences to leak on a target that doesn't honour bracketed paste.

- `auto` (default) — paste-wrap only when the payload has newlines
- `paste` — always wrap
- `literal` — never wrap (raw `sendText`)
- `join` — collapse interior newlines to spaces, delivering one line. The fallback if a particular target turns out not to honour bracketed paste.

**Prompt-state safety.** Text injected while the target sits at a permission dialog or a numbered question is consumed as *an answer to that menu*, not read as a message. `/send-text` returns **409** when the tracked status is `needs-input` or `permission`; pass `force=1` when answering the prompt is what you actually mean. Unknown or non-live terminal → **404**.

**Exit 0 means delivered, not received.** `sendText` queues in the terminal buffer when the target is mid-execution, so a successful response says the text was written — not that the agent read it or acted on it. To confirm pickup, compare `lastHeartbeatAt` against `lastSendAt` in `/list`: a heartbeat *after* your send means the agent has acted since your text landed (v0.20.0+). Don't watch for a status transition instead — hooks fire on tool calls, so a status can lag a pickup by minutes, and a transition that does occur can't be attributed to your send.

Or via the bundled client:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send my-task "rebase onto main and re-run /pre-pr"
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send my-task --text-file=/tmp/msg.txt
```

Note this closes only the orchestrator→agent half of the loop. Reading a terminal's output back is a separate problem with no stable VS Code API — tracked in [#32](https://github.com/solcarty/vscode-terminal-bridge/issues/32).

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

| `status=` | Codicon | Color | When to use |
| --------- | ------- | ----- | ----------- |
| `working` | `$(loading~spin)` | cyan | `PreToolUse` — agent is actively running a tool |
| `needs-input` | `$(bell-dot)` | yellow | `Notification` — agent needs a content decision |
| `idle` | `$(debug-pause)` | green | `Stop` — agent turn complete |
| `permission` | `$(shield)` | blue | `PermissionRequest` — tool needs explicit approval |
| `error` | `$(error)` | red | `PostToolUseFailure` / `StopFailure` — needs human eyes |
| `compacting` | `$(archive)` | blue | `PreCompact` — auto-compaction running |
| `subagent` | `$(symbol-array)` | magenta | `SubagentStart` — parallel sub-agent active |
| `bg-task` | `$(server-process)` | blue | `TaskCreated` — **routed to the background-work dimension** (v0.21.0+), see below. Prefer `/bg-task?op=start` |
| `task-done` | `$(check-all)` | green | `TaskCompleted` — decrements the background count when work is outstanding (v0.21.0+); otherwise a sticky "go look at this" badge |
| `pr-open` | `$(pass-filled)` | green | After `gh pr create` |
| `merged` | `$(git-merge)` | magenta | After merge |
| `none` | *(strip prefix)* | *(unchanged)* | Manual reset |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

# Status mode — bridge handles codicon + color (idempotent)
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=working"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=needs-input"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=idle"

# Quiet + status — silent color update, no label change, no panel flicker
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&quiet=1&status=working"

# Legacy label override
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&label=%E2%9C%85%20my-task%20done&color=terminal.ansiGreen"

# Update base label while keeping the current status prefix
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=working&label=my-task%20v2"
```

Response (status mode):

```json
{
  "ok": true,
  "name": "my-task",
  "label": "$(loading~spin) my-task",
  "baseLabel": "my-task",
  "icon": null,
  "color": "terminal.ansiCyan",
  "status": "working"
}
```

Response (idempotent no-op):

```json
{
  "ok": true,
  "name": "my-task",
  "label": "$(loading~spin) my-task",
  "baseLabel": "my-task",
  "icon": null,
  "color": "terminal.ansiCyan",
  "status": "working",
  "noOp": true
}
```

Returns `404` if the terminal is not in the registry (e.g. opened before the last reload).

---

### `GET /set-note` · `GET /note` · `GET /clear-note`

A short handoff a worker publishes for its orchestrator to read (v0.22.0+).

| Endpoint | Parameters | Purpose |
| -------- | ---------- | ------- |
| `/set-note` | `name` (req), `text=` or `textFile=` | Publish a note (parameter shape mirrors `/send-text`) |
| `/note` | `name` (req) | Read one terminal's note body |
| `/clear-note` | `name` (req) | Remove it |

```bash
curl "http://127.0.0.1:${PORT}/set-note?name=my-task&textFile=/tmp/handoff.md"
curl "http://127.0.0.1:${PORT}/note?name=my-task"
```

```json
{
  "ok": true, "name": "my-task",
  "note": "state: done\nshipped: pr=44 branch=feat/x sha=abc123\n",
  "noteUpdatedAt": "2026-08-19T15:02:11.004Z",
  "truncated": false, "bytes": 58
}
```

Via the bundled client:

```bash
# worker, from anywhere — resolves its own tab name like hook-status does
bridgectl note set "blocked: needs a decision on the schema bump"
bridgectl note set --text-file=/tmp/handoff.md
bridgectl note clear

# orchestrator
bridgectl note get my-task
```

#### Why this exists

`send` closed orchestrator → worker. The reverse direction is [#32](https://github.com/solcarty/vscode-terminal-bridge/issues/32), which is blocked on APIs that don't exist — `onDidWriteTerminalData` is proposed-only, and the shell-integration APIs model discrete commands rather than a long-running TUI.

But most of what an orchestrator needs from a worker isn't the raw buffer. It's a handful of facts: *am I done, what did I ship, what needs deciding, what did I touch.* That subset doesn't require reading output at all — only the worker being able to **publish** it. This doesn't replace `#32` (raw output is still the only way to see what actually happened when a worker's own account is wrong); it makes the common case work without waiting for it.

#### `/list` carries the timestamp, not the body

An orchestrator polls `/list` constantly. Inlining N note bodies would make every triage pass proportional to how much everyone has written, so `/list` exposes `noteUpdatedAt` / `noteBytes` / `noteTruncated` and nothing else. Fetch bodies from `/note` only for the entries whose timestamp moved.

Notes are persisted in workspace state alongside `status`, so they **survive a window reload** — which is exactly the moment context is lost and a note is worth most.

#### Notes over 4KB are truncated, not rejected

The cap is 4096 bytes, applied on a character boundary so the stored note stays valid UTF-8. The response reports `truncated: true` and `bytes`, and `/list` carries `noteTruncated`. Truncation rather than rejection because a clipped handoff still carries the facts at its head — this is a summary, not a log. Detail belongs in the terminal and in whatever the worker wrote to disk locally.

#### A note is a self-report — prefer receipts to prose

Same caveat that motivated the heartbeat: `status` says what the agent *claims*. A prose note has that problem with more authority, because it reads like a report. Two real cases from one afternoon of orchestrating, both caught only by checking git/PR state against the claim:

- A worker reported shipping one PR when it had actually shipped a different one — it had picked up the number of a pre-existing PR on a sibling branch. The narrative was detailed, confident, and wrong about the one fact that mattered.
- A worker reported "zero writes" for a verification run. True of the engine call — but it had also closed a fixture row in a **shared** environment and toggled a runtime setting there. Neither appeared in the summary.

So write notes as **checkable pointers**, not narrative:

```
state: done | blocked | needs-decision
shipped: pr=<number> branch=<branch> sha=<sha>
touched: env=shared-dev  mutations=1 row  restored=<flag>=false
needs-decision: <one line>
findings: <one line each>
```

Everything under `shipped` and `touched` can be independently verified by the orchestrator, so it *reconciles* rather than relays. `touched` is the one to insist on — shared-environment side effects are what an orchestrator most needs surfaced, and no status colour can carry them.

The bridge does **not** validate note contents, the same way it deliberately doesn't derive status from staleness. Report facts; let the caller judge.

#### Notes from a remote worker node

A worker on another machine has no shared filesystem with the orchestrating session and can't reach its `127.0.0.1` bridge, so `bridgectl note set` takes a different route there — automatically, with no change to the command:

1. `bin/worker.js` exports `WORKER_JOB_ID` / `WORKER_PORT` / `WORKER_TOKEN` into every job's environment.
2. `bridgectl note set` sees those and POSTs to `/job-note` on the worker daemon instead of the local bridge.
3. The note rides home on the next `/job-status` poll, and `bridge-tail.sh` relays it into the orchestrator's bridge — only when `noteUpdatedAt` changes, so a static note isn't rewritten every three seconds.

The same 4KB cap applies at both ends.

---

### `GET /bg-task`

Reports **outstanding background work**, which is a dimension of its own — not a `status=` value (v0.21.0+).

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name |
| `op` | No | `start` (default) / `end` / `clear` |

```bash
curl "http://127.0.0.1:${PORT}/bg-task?name=my-task&op=start"   # a task is now outstanding
curl "http://127.0.0.1:${PORT}/bg-task?name=my-task&op=end"     # one finished
curl "http://127.0.0.1:${PORT}/bg-task?name=my-task&op=clear"   # reset the count
```

```json
{
  "ok": true, "name": "my-task", "op": "start",
  "pendingTasks": 1, "bgTask": true,
  "bgTaskStartedAt": "2026-08-19T14:45:15.367Z",
  "status": "idle", "displayStatus": "bg-task",
  "label": "$(server-process) my-task"
}
```

#### Why this isn't a status

`status` is a single last-writer-wins scalar, but the things being written into it are not mutually exclusive. Two independent dimensions were sharing one field:

- **Turn state** — working / idle / waiting on input. Written by `PreToolUse`, `Notification`, `Stop`.
- **Outstanding background work** — written by `TaskCreated` / `SubagentStart`.

An agent that starts a background task and *then ends its turn* wrote `bg-task`, and `Notification`/`Stop` overwrote it moments later. Both writes were correct about their own dimension; collapsing them meant the later one silently erased the earlier — and the tab read `needs-input`, the one status that asserts a human is required, for exactly the interval the work was actually in flight. An orchestrator reading `/list` routed attention to a tab that needed nothing.

Separate fields mean there are no precedence rules to get wrong, and the both-at-once case — genuinely blocked on a human *while* a task runs — is representable, which no single scalar can express.

#### What the tab renders

`/list` reports both dimensions raw; `displayStatus` is the derived value the tab shows:

1. `needs-input`, `permission`, `error` — a human being required outranks a machine being busy.
2. Otherwise `bg-task` if `pendingTasks > 0` — "idle" on a terminal with a job in flight is the reading that sent an orchestrator to the wrong tab.
3. Otherwise the raw turn state.

That precedence is a **display** decision only. `status`, `pendingTasks`, and `bgTask` stay orthogonal in the data, so a consumer can apply its own rule.

#### Existing hook wiring keeps working

`status=bg-task` arriving on `/rename-terminal` is routed into this dimension instead of overwriting the turn state, and `status=task-done` decrements it — so hooks already wired against those values are fixed without editing anyone's `settings.json`. `task-done` on a terminal with **nothing** outstanding still behaves as the manual completion badge it always was.

Keep `start` and `end` wired as a pair: a start with no matching end leaves the count above zero indefinitely. The bridge will not guess — it never derives one dimension from the staleness of another (`bgTaskStartedAt` is reported so you can apply your own threshold).

Via the bundled client: `bash ~/.vscode-terminal-bridge/bin/bridgectl.sh bg-task start` (resolves the terminal name from `$CLAUDE_TAB_NAME` / cwd exactly like `hook-status`).

---

### `GET /close-terminal`

Closes a tracked terminal tab and removes it from the registry. If the
in-memory registry has desynced from reality (extension host restart,
multi-window scenarios), it falls back to a live-window name search and
finally to killing the persisted PID directly — so cleanup succeeds even
when the registry's own bookkeeping is wrong.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
curl "http://127.0.0.1:${PORT}/close-terminal?name=my-tab"
```

Response:

```json
{ "ok": true, "name": "my-tab", "outcome": "closed", "method": "dispose" }
```

`outcome` (v0.19.0+) is the field to branch on:

| `outcome` | HTTP | Means |
| --------- | ---- | ----- |
| `closed` | 200 | A live terminal object was disposed, or its persisted PID was killed |
| `row-removed` | 200 | The terminal and its process were already gone; the tracked row was removed |
| `not-tracked` | 404 | No row under that name — nothing to remove |

`method` refines the `closed` case: `"dispose"` when a live terminal object
was found, `"pid-kill"` when the registry had no object reference and the
persisted shell PID was signalled instead. `row-removed` reports
`"method": "registry"`.

**`close` reconciles the registry, not just the terminal object** (v0.19.0+).
Before this, closing a name whose process had already exited returned success
having done nothing, and left a row that no targeted verb could remove —
`/sweep` was the only escape, and `/sweep` takes no target, so clearing one
stale row meant risking every live worktree tab. A caller naming a specific
terminal has already expressed the intent; there is no reading of
`close my-tab` where leaving the row behind is the desired outcome.

---

### `GET /forget-terminal`

Removes a tracked row and **nothing else** — never signals a PID, never
disposes a terminal object. The targeted counterpart to `/sweep`, for a row
you know is dead and want cleared without sweep's blast radius.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name |

```bash
curl "http://127.0.0.1:${PORT}/forget-terminal?name=my-tab"
```

Response:

```json
{ "ok": true, "name": "my-tab", "outcome": "row-removed", "wasLive": false }
```

`wasLive` reports whether a terminal object under that name still existed
when the row was dropped — `true` means you have just untracked a tab that is
still open on screen, which is legal but rarely what you meant. Unknown names
return `404` with `"outcome": "not-tracked"`.

---

### `GET /sweep`

Cross-references all persisted terminals against ground truth
(`git worktree list`) and disposes any whose `cwd` no longer corresponds to
an existing worktree — falling back to a PID kill when no live terminal
object can be found. Runs automatically a few seconds after the extension
activates (catches leaks left over from a crash/restart), and can also be
called on demand.

```bash
curl "http://127.0.0.1:${PORT}/sweep"
```

Response:

```json
{ "ok": true, "closed": ["task-a", "task-b"] }
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
curl ".../open-terminal?name=my-task&icon=hubot&color=terminal.ansiCyan&cmd=..."

# Hook (PreToolUse) — silent color update, no flicker
curl ".../rename-terminal?name=my-task&quiet=1&color=terminal.ansiCyan"
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

| Hook / event | `status=` | Tab shows | Color |
| ------------ | --------- | --------- | ----- |
| `PreToolUse` | `working` | `$(loading~spin) my-task` | Cyan |
| `Notification` | `needs-input` | `$(bell-dot) my-task` | Yellow |
| `Stop` | `idle` | `$(debug-pause) my-task` | Green |
| `PermissionRequest` | `permission` | `$(shield) my-task` | Blue |
| `PostToolUseFailure` / `StopFailure` | `error` | `$(error) my-task` | Red |
| `PreCompact` | `compacting` | `$(archive) my-task` | Blue |
| `SubagentStart` | `subagent` | `$(symbol-array) my-task` | Magenta |
| `TaskCreated` | `bg-task start` *(a separate dimension — see [`/bg-task`](#get-bg-task))* | `$(server-process) my-task` | Blue |
| `TaskCompleted` | `bg-task end` | reverts to the turn state | — |

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
    ],
    "TaskCreated": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.vscode-terminal-bridge/bin/bridgectl.sh bg-task start",
            "async": true,
            "timeout": 2
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.vscode-terminal-bridge/bin/bridgectl.sh bg-task end",
            "async": true,
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

`TaskCreated` / `TaskCompleted` write the **background-work dimension**, not `status` — that's what stops an agent waiting on a job it started from reporting `needs-input` the moment its turn ends. Wire them as a pair; see [`/bg-task`](#get-bg-task).

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

### `hook-status` — one line instead of the template (v0.17.0+)

Every hook script above re-derives the same two things: which port to talk to, and what this terminal is called. `bridgectl hook-status` absorbs both, so a hook becomes one line:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status working
```

It resolves the terminal name from, in order: `--name=<name>` (or a two-arg `<name> <status>` form), `$CLAUDE_TAB_NAME` (exported into every bridge-opened terminal), a `"rootPath"` in a JSON payload on stdin (how Cline passes context — see below), and finally the basename of `$PWD`. It always drains stdin when stdin isn't a tty, so a hook runner writing a payload never blocks on a reader that isn't there. Like `status`, it no-ops silently outside VS Code.

Because it lives in the version-matched copy under `~/.vscode-terminal-bridge/bin/`, the conventions stay current instead of being frozen into each repo's hook scripts at whatever they were on the day those were written. `bridgectl scaffold --backend claude` prints a ready-to-merge `settings.json` snippet using it.

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

## Using the Cline CLI as an alternate backend

[Cline CLI](https://www.npmjs.com/package/cline) (`npm i -g cline` — a separate tool from the Cline VS Code extension) can drive a bridge terminal the same way Claude Code does. It has its own project-level instruction system, deliberately similar to Claude Code's but not identical:

| Cline convention | Location | Claude Code equivalent |
| ---------------- | -------- | ----------------------- |
| Rules (always loaded into context) | `.cline/rules/*.md` (also `.clinerules/`) | `CLAUDE.md` |
| Workflows (invoked as `/<name>`, e.g. `cline "/pre-pr"`) | `.cline/workflows/<name>.md` | `~/.claude/commands/<name>.md` |
| Hooks | `.cline/hooks/<EventName>.{sh,js,py,...}` — filename (case-insensitive, extension stripped) matched directly against the event name, no registration step | `settings.json` `hooks` key |

Cline hook event names were deliberately chosen to mirror Claude Code's:

| Cline file name | Cline internal event | Claude Code equivalent |
| ---------------- | --------------------- | ----------------------- |
| `TaskStart` | `agent_start` | closest: `PreToolUse` on the first tool call |
| `TaskResume` | `agent_resume` | — |
| `TaskCancel` | `agent_abort` | — |
| `TaskComplete` | `agent_end` | `Stop` |
| `TaskError` | `agent_error` | `StopFailure` |
| `PreToolUse` | `tool_call` | `PreToolUse` (identical name) |
| `PostToolUse` | `tool_result` | `PostToolUse` (identical name) |
| `UserPromptSubmit` | `prompt_submit` | `UserPromptSubmit` (identical name) |
| `SessionShutdown` | `session_shutdown` | — |

**Key difference from Claude Code hooks:** each Cline hook script receives its JSON payload on **stdin** (not argv, not env) — `{ hookName, workspaceInfo: { rootPath }, taskId, ... }`. Claude Code hooks, by contrast, get context via env vars (`$CLAUDE_TAB_NAME`, `$PWD`) and the command template is inlined into `settings.json`.

### Scaffolding the hooks (v0.17.0+)

Because Cline matches hooks by **filename** against its event names, with no registration step, the whole set can be generated:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend cline --dir=/path/to/repo
# scaffold: wrote 6 hook(s) to /path/to/repo/.cline/hooks (skipped 0 existing; --force to overwrite)
```

That writes `TaskStart`, `TaskResume`, `PreToolUse` → `working`; `TaskComplete`, `TaskCancel` → `idle`; `TaskError` → `error`. Existing files are left alone unless you pass `--force`. Each generated script is a single line:

```bash
#!/usr/bin/env bash
exec bash "$HOME/.vscode-terminal-bridge/bin/bridgectl.sh" hook-status working
```

Since Cline's headless `--auto-approve` mode emits no permission-prompt or subagent-spawn events, that 3-state model (`working` / `idle` / `error`) is the whole of what it can report — there's no Cline equivalent of `needs-input` or `subagent`.

Written by hand, the equivalent `.cline/hooks/TaskStart.sh` is:

```bash
#!/usr/bin/env bash
# Cline passes the payload on stdin — read it even if unused, so the pipe doesn't block.
cat >/dev/null
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)
N="${CLAUDE_TAB_NAME:-$(basename "$PWD")}"
curl -s "http://127.0.0.1:${PORT}/rename-terminal?name=$N&status=working" >/dev/null 2>&1 || true
```

which is exactly the duplication `hook-status` exists to remove — five copies of it per repo, per backend, each frozen at whatever the port-discovery rules were the day it was written.

**Provider gotcha:** Cline's `ollama` provider id does not accept a custom base URL (`cline auth ollama -b <url>` errors with "base URL is only supported for OpenAI and OpenAI-compatible providers"). To point Cline at a remote/non-default Ollama host, use the `openai-compatible` provider id instead: `cline auth openai -b http://<host>:11434/v1 -m <model> -k <dummy>`.

To launch a bridge terminal running Cline instead of Claude Code, just change the `cmd`:

```bash
curl "http://127.0.0.1:${PORT}/open-terminal?name=my-task&cwd=${CWD}&cmd=$(python3 -c "import urllib.parse; print(urllib.parse.quote('cline -P openai-compatible -m my-model --auto-approve true \"do the thing\"'))")"
```

---

## Automated worktree setup

Open a named terminal for a git worktree, attach the worktree to the VS Code workspace, and start Claude automatically — all via the HTTP bridge, no `code` CLI required:

```bash
ISSUE="my-task"
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

The terminal is registered under `my-task`, so the Claude Code hooks above rename it automatically, and `/close-terminal?name=my-task` closes it when the work is done. When the worktree is cleaned up, call `/remove-folder` to detach it from the workspace.

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

## Remote jobs

A long-running job (e.g. a multi-hour local LLM generation) can run on a separate machine on your network — a Mac Mini, a homelab VM, anything reachable over the LAN — instead of blocking your laptop, while still showing up as a normal terminal tab with a live status icon.

This works without VS Code running on the worker machine: `bin/worker.js` is a standalone, dependency-free Node daemon (no `vscode` import) that runs headless under launchd. The laptop's `/open-terminal` gains a `node=` param — when set, instead of running `cmd` in this window, it POSTs the job to the named worker, which:

1. Fetches the configured ref (`ref=`, default `main`) and resolves it to a SHA.
2. Cuts a fresh `git worktree` at that SHA under `<repo>-worktrees/<jobId>` — every job starts from current main, and concurrent jobs never collide with each other.
3. Runs the command inside an [rmux](https://rmux.io/) session (a tmux-compatible, scriptable multiplexer), so the job survives the laptop sleeping or VS Code closing.

The laptop still opens a local terminal tab for the job. That tab doesn't run the job — it runs `bridge-tail.sh <node> <jobId>` (bundled the same way as `bridgectl.sh`), which polls the worker's `/job-status` and drives the tab's icon via the existing `/rename-terminal?status=` mechanism. The job looks and feels local even though it isn't. After a window reload, any tracked terminal with a `node`/`jobId` in its persisted metadata is reattached automatically if the remote job is still running.

### Setting up a worker node

1. Clone this repo onto the worker machine — this becomes its canonical `WORKER_REPO_DIR`.
2. Generate a token: `openssl rand -hex 32`.
3. Run the daemon with env vars set:

   ```bash
   WORKER_TOKEN=<token> WORKER_REPO_DIR=/path/to/clone node bin/worker.js
   ```

   Put this under launchd (`KeepAlive: true`, `RunAtLoad: true`) so it survives crashes/reboots. `WORKER_PORT` defaults to `31416` — deliberately different from the local bridge's `31415`.

4. On the laptop, add the node to `~/.vscode-terminal-bridge/nodes.json` (`chmod 600` it — it holds a bearer token):

   ```json
   { "m1": { "host": "192.168.1.50", "port": 31416, "token": "<same token>" } }
   ```

5. Sanity check before trusting it: `bash ~/.vscode-terminal-bridge/bin/bridgectl.sh ping --node m1`.

### Running a job on a node

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open llm-gen /any/local/path \
  "run-the-long-job.sh" --node=m1
```

### Worker endpoints (`bin/worker.js`)

Unlike the local bridge, every worker endpoint requires `Authorization: Bearer <token>` and binds `0.0.0.0` — this is the only part of the system exposed beyond `127.0.0.1`, so treat the token like an SSH credential.

| Endpoint | Purpose |
| --- | --- |
| `POST /run-job` | Body `{ jobId, cmd, ref? }`. Cuts a worktree at the resolved ref and starts `cmd` in an `rmux` session. |
| `GET /job-status` | `?id=&offset=` — returns `{ done, exitCode, running, logChunk, nextOffset }`. `offset`/`nextOffset` let callers tail the log incrementally instead of re-fetching it whole. |
| `POST /job-note` | `?id=` — body is a job's published note (≤4KB). Returned by `/job-status` and relayed into the local bridge by `bridge-tail.sh`; see [notes](#notes-from-a-remote-worker-node). |
| `POST /sweep-job` | `?id=` — removes a job's worktree. Runs automatically on successful (`exitCode === 0`) completion; call manually for a failed job once you're done inspecting it. |
| `GET /ping` | Health check — returns `{ ok, port, hostname }`. |

### Job lifecycle / cleanup

- A job's worktree is **auto-removed** on successful completion.
- A **failed** job's worktree is left in place for manual inspection — `git worktree remove` it yourself, or hit `/sweep-job` once you're done.
- To inspect a stuck or running job directly: SSH into the worker and run `rmux attach -t <jobId>`.

## Security

The local bridge (`extension.js`) binds to `127.0.0.1` only — it is **not** accessible from other machines on the network, and has no authentication because it controls only your local VS Code instance.

The worker daemon (`bin/worker.js`, see [Remote jobs](#remote-jobs)) is different: it binds `0.0.0.0` so a laptop on the LAN can reach it, and **does** require a bearer token on every request. Anyone with that token can run arbitrary shell commands on the worker machine — store it like an SSH key (`chmod 600` on `nodes.json`, never commit it).

## License

MIT
