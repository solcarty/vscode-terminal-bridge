# VS Code Terminal Bridge

A tiny VS Code extension that exposes a local HTTP API for managing terminal tabs programmatically — open and close named terminals, and track each one's status, from bash scripts, shell tools, or any process that can make an HTTP request.

Built to solve a real problem: VS Code extensions and external scripts **cannot** reliably open terminals using AppleScript, keystrokes, or CLI flags. This extension uses the native `vscode.window.createTerminal` API, exposed via a local-only HTTP server.

It has since grown into the substrate for running **agents** in terminals — spawning them, telling a working one from a wedged one, reading results back, and supervising several at once. If that is what you're here for, the [API](#api) is the reference and [Implementation patterns](#implementation-patterns) is how the pieces compose.

> **Where things are documented.** This README is the contract: every endpoint, field, setting and pattern a caller needs. [`CLAUDE.md`](CLAUDE.md) is the design record — why a field is shaped the way it is, and which incident made it necessary. When behaviour changes, both change: the reference here, the reasoning there.

## How it works

On activation, the extension starts an HTTP server on `127.0.0.1` — unless a [headless bridge](#headless-mode-no-vs-code-window) already serves this host, in which case the window shows that bridge's terminals instead. It tries port **31415** first; if that port is already taken (e.g. a second VS Code window is open), it increments until it finds a free port (`31416`, `31417`, …), giving up after 32 attempts.

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
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh repaint         # no-op since v0.29.0 — titles are fixed at open
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send   <name> <text>|--text-file=<path> [--no-submit] [--force] [--mode=...] [--submit-delay=<ms>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh nudge  <name> [--force]   # bare Enter — releases a paste left staged in the input box
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh list
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh bg-task {start|end|clear} [--name=<name>]   # outstanding background work
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh note set <text>|--text-file=<path>          # publish a handoff
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh note get <name>                             # read one back
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh output <name> [--n=<1..3>]                  # read back what it last said
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh pr <name> <url>                             # record a PR url (advisory, last write wins)
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh rename <name> <label> [icon] [color]   # registry only — the tab keeps its open-time title
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh announce <status>                           # this window's own agent, not a tab
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh agents                                      # every live window — cwd-independent
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh worker --prompt-file=<path> [--permission-mode=<m>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh sweep [--dry-run]                             # --dry-run prints what would close
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh ping [--node=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status <status> [--name=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-output                                 # Stop hook: publish the turn's final text
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend {cline|claude} [--dir=<repo>] [--force]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend claude --apply [--settings=<path>]   # merge the hooks, don't print them
```

Or source the functions directly:

```bash
. ~/.vscode-terminal-bridge/bin/vscode-bridge.sh
bridge_open "$NAME" "$CWD" "$CMD"
bridge_status "$NAME" working
```

Both handle port discovery (walking up for `.vscode-bridge-port`, preferring `$VSCODE_BRIDGE_PORT` when set — see [Multi-window setup](#multi-window-setup)), falling back to `~/.vscode-terminal-bridge/port` when the caller's cwd sits outside every workspace folder. `bridge_open` and `bridge_status` return a non-zero exit code and print an error to stderr on real failures (bridge unreachable, malformed args, bridge-reported error) rather than swallowing them. Source: `bin/` in this repo.

**Mutating vs. query commands.** `open`/`close`/`status`/`rename`/`sweep` no-op silently when the bridge isn't reachable — hooks call them outside VS Code and shouldn't fail under `set -e`. **`list` is different:** it prints `{"ok":false,"reason":"bridge-unreachable"}` and exits non-zero, because an empty result with exit 0 is indistinguishable from "bridge is up, tracking zero terminals". Anything polling `list` to decide whether a terminal is still alive would read that silence as fact and conclude a dead tab was simply an empty list. **If you consume `list`, check the exit code** rather than treating empty output as "no terminals".

`send` follows `list`, not the mutating commands: a message you believe was delivered but wasn't is worse than a loud failure, so an unreachable bridge, an unknown name, or a dead terminal all exit non-zero with a JSON reason.

## Workspace requirement

The `.vscode-bridge-port` file is written to each **workspace folder** — a path that VS Code has open as a root in the Explorer. If you open a loose file or a folder that isn't part of a workspace, no per-folder port file is written there.

The extension also writes the active port to `~/.vscode-terminal-bridge/port`, which the shell helpers consult when walking up from `$PWD` finds nothing. This matters for **agent-spawned shells**: they inherit neither `$TERM_PROGRAM` nor `$VSCODE_BRIDGE_PORT`, so the walk-up was previously their only discovery path — and a shell that had `cd`'d to `/tmp` or a scratch directory would conclude "no bridge" while the server was running perfectly well. A caller's working directory is not evidence about whether a local HTTP server exists. Port discovery still falls back to `31415` if neither file is present.

For the port file to work correctly, your repo root must be open as a workspace folder (the normal case when you open a folder with `code .` or `code-insiders .`). When you add worktrees with `/add-folder`, the extension writes the port file there too, so hooks and scripts running inside a worktree terminal always find the right port.

## VS Code title format (recommended)

This setting only matters for terminals **not** opened by the bridge — a tab opened via `/open-terminal` gets the static `name` it was opened with, which overrides whatever title format VS Code would otherwise compute and is never changed afterwards (see [fixed at open](#tab-titles-icons-and-colors-are-fixed-at-open)). For everything else — terminals you open manually — this format gives you a useful default: the live shell title on the left, the workspace folder name on the right.

**Settings → Terminal › Integrated › Tabs: Title** (or edit `settings.json`):

```json
"terminal.integrated.tabs.title": "${sequence}${separator}${rootWorkspaceFolderName}"
```

This gives you:

- `${rootWorkspaceFolderName}` — always shows the workspace folder name on the right
- `${sequence}` — shows any OSC title sequences emitted by the shell on the left

## The Terminal Bridge side panel

**Tab titles don't carry status.** Since v0.29.0 a terminal's title is the `name` it was opened with and never changes (see [fixed at open](#tab-titles-icons-and-colors-are-fixed-at-open)). Status, progress and the note are shown in the *Terminal Bridge* view in the activity bar instead. It reads the same registry `/list` serves.

One row per tracked terminal whose tab is still open:

| Part | What it shows |
| ---- | ------------- |
| Label | The terminal's name |
| Description | The caller's progress text: the `rename` label minus the name (`rename feat-12 "feat-12 8/1/9 next 16:10"` shows `8/1/9 next 16:10`). With no progress text, the first line of the [note](#get-set-note--get-note--get-clear-note). |
| Icon | The status codicon and color from the [status table](#status-values), for the row's `displayStatus` (so outstanding background work shows `bg-task` unless a person is needed) |
| Tooltip | Status and how long it has been in it, the note, `cmdDelivery`, the PR URL when set, `node` when set |
| Click | Shows that terminal |

**Order:** rows that need a person first (`needs-input`, `permission`, `error`), then `working`, then the rest. Within each group the newest terminal (by `createdAt`) comes first. Grouping uses the raw `status`, so a `working` terminal with a background task still sorts with `working`.

**Untracked:** terminals in the window that the bridge doesn't track, including a duplicate tab that shares a tracked name but isn't the bound one, are listed in a collapsed *Untracked* group, so a stray tab can be found and closed. Clicking one shows it.

**Refresh:** on every registry write (open, close, status, rename, note, PR, background task, heartbeat) and whenever a terminal opens or closes. While any row is `working`, the panel also re-reads once a second, so the time in the tooltip stays current. Otherwise it doesn't poll. A row whose terminal has gone drops on the next refresh.

### The *All hosts* view

A window that watches other machines can show every host's terminals at once, in a second view in the same container. It is fed by a command you choose, not by this bridge's registry, and the bridge knows nothing about your hosts beyond what that command prints. Set [`terminalBridge.hostsCommand`](#settings) to turn it on. Empty (the default), there is no view and nothing runs.

**The contract.** The command prints one JSON document on stdout:

```json
{
  "hosts": [
    {
      "name": "build-box",
      "self": false,
      "ok": true,
      "error": "only when ok is false",
      "load": 0.47,
      "cpus": 16,
      "memAvailableGb": 23.2,
      "memTotalGb": 31.1,
      "workers": 3,
      "workerCap": 4,
      "remoteUri": "vscode-remote://ssh-remote+build-box/home/me/repo",
      "terminals": [ /* rows exactly as /list returns them */ ]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The host's name, shown as its header |
| `ok` | yes | `true` when the host answered. `false` shows `error` and keeps the host's last good reading |
| `terminals` | yes | That host's [`/list`](#get-list) rows, unchanged. Rows with `live: false` are left out |
| `self` | no | `true` for the host this window runs on. Its rows show the local terminal when clicked |
| `error` | no | Why the host did not answer |
| `load`, `cpus`, `memAvailableGb`, `memTotalGb`, `workers`, `workerCap` | no | The header's reading. `null` or absent parts are left out |
| `remoteUri` | no | A folder URI that opens this host's VS Code window (`vscode.openFolder`) |

Only stdout is read. The exit status is ignored, so a command may exit non-zero to say a host is down and still print the document. A run fails when it doesn't finish in 20 seconds, or its output isn't JSON with a `hosts` array.

**Headers:** one per host, in the document's order: its name, then `load 0.47 / 16 · 23 of 31 GB free · 3 of 4 workers`. When any of its terminals needs a person (`needs-input`, `permission`, `error`), the count comes first (`2 need a person · …`) and the icon is the bell. A host with `ok: false` shows its error and the age of its last good reading (`ssh: … timed out · last reading 4m ago`), with that reading's terminals still under it. One host down never blanks the others.

**Rows:** each host's terminals, shaped and ordered exactly like [the Terminals view](#the-terminal-bridge-side-panel) (name, status icon, progress text, tooltip). `/list` rows carry no note body, so a row with no progress text has no description.

**Click:** a row on the `self` host shows that terminal. A row on another host with a `remoteUri` opens that host's window, or focuses it if it is already open. With no `remoteUri`, `<host> <terminal>` is copied to the clipboard.

**Refresh:** the command runs when the view becomes visible and every 30 seconds while it stays visible, never while it is hidden or collapsed. A run is killed (with its process group) after 20 seconds. When a run fails, the last good result stays on screen and the view's title reads `stale · <age> old` until the next good run.

**Read only.** The view sends nothing to any host. Whatever reaching your hosts takes (SSH, an API) lives in the command.

## Settings

Three, all per-window (set them in `.vscode/settings.json` for a workspace, or in user settings):

| Setting | Default | What it does |
| --- | --- | --- |
| `terminalBridge.agentId` | unset | Names the agent driving this window, for [presence](#get-announce--get-apibridges). Falls back to the workspace name VS Code shows in its title bar, then the first workspace folder's basename, then `null` — never fabricated. Set it when the folder name isn't the identity you want other windows to see. |
| `terminalBridge.hostsCommand` | empty | A shell command (run with `/bin/sh -c` from your home directory) that prints the [All hosts](#the-all-hosts-view) JSON. Set: the *All hosts* view appears. Empty: no view, nothing runs. Use an absolute path if the command isn't on VS Code's `PATH`. |
| `terminalBridge.pipelineStateDir` | `.sdo` | Directory, relative to the matched workspace folder, where [`/api/status`](#post-apistatus) appends `pipeline-state.json`. The default is a private consumer's convention kept for compatibility; point it somewhere of your own. |

## What the extension injects into every terminal it opens

`/open-terminal` exports three variables into the shell it creates. Anything running in that tab — hooks, subshells, scripts — inherits them, which is how a hook fired deep inside an agent's tool call still knows which window and which tab it belongs to:

| Variable | Value |
| --- | --- |
| `VSCODE_BRIDGE_PORT` | The exact port of the window that spawned this terminal. Preferred over any port file, and the reason a bridge-spawned tab is immune to the [multi-window race](#multi-window-setup). |
| `VSCODE_BRIDGE_ORCHESTRATOR_ID` | The tab's tracked `name` — what `hook-status` and `note set` resolve themselves to without being told. |
| `VSCODE_BRIDGE_STATUS_URL` | Fully-formed `http://127.0.0.1:<port>/api/status` for this window. |

*v0.27.0+ ([#57](https://github.com/solcarty/vscode-terminal-bridge/issues/57)).* The last two were previously `HH_ORCHESTRATOR_ID` and `HH_BRIDGE_STATUS_URL` — named after one private consumer, in a general-purpose extension's public contract. **This release exports both the old and the new names**, so nothing that reads either breaks; the `HH_`-prefixed pair is deprecated and will be dropped in a later release. Update your scripts to the `VSCODE_BRIDGE_` names now.

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

`backend` (v0.33.0+) says which bridge answered: `vscode` for the extension, `tmux` for a [headless bridge](#headless-mode-no-vs-code-window). A headless bridge reports its own `pid` and its `tmuxSocket` instead of `ipcHook`.

`version` (v0.33.2+) is the bridge's `package.json` version. The [presence](#get-announce--get-apibridges) entry carries it too. A bridge from before v0.33.2 omits it.

---

### `GET /announce` · `GET /api/bridges`

*v0.27.0+ ([#55](https://github.com/solcarty/vscode-terminal-bridge/issues/55)).* Presence for the agent **driving** a window, as opposed to the tabs it spawns.

Everything else in this API describes bridge-managed terminals. The main agent is not one of them — it is the session you talk to, which opens those tabs. It cannot be observed the way a tab is, so it announces itself:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh announce working
# or: curl "http://127.0.0.1:${PORT}/announce?status=working"
```

`status` reuses the [status vocabulary](#status-values) and the same discipline as terminal status: `statusChangedAt` moves only on a value *change*, `lastHeartbeatAt` moves on every call. Same honesty caveat as everywhere else here — it is what was last announced, not what is true now.

Read every live window back:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh agents
# or: curl "http://127.0.0.1:${PORT}/api/bridges"
```

```json
{
  "ok": true,
  "now": "2026-09-12T10:44:31Z",
  "bridges": [
    {
      "id": "6f1c…", "port": 31415, "pid": 12345,
      "self": true, "pidAlive": true,
      "agentId": "house.health", "status": "working",
      "startedAt": "2026-09-12T10:00:00Z",
      "statusChangedAt": "2026-09-12T10:31:02Z",
      "lastHeartbeatAt": "2026-09-12T10:44:17Z",
      "workspaceName": "house.health",
      "workspaceFolders": ["/Users/you/Workspace/house.health"]
    }
  ]
}
```

(`bridgectl agents` returns the same rows under an `agents` key rather than `bridges`, since it never talks to a bridge to produce them.)

**`agents` is the one command that does not go through any bridge's HTTP server.** It reads `~/.vscode-terminal-bridge/bridges/` off disk directly, because reaching a bridge over HTTP means already knowing a port — the exact thing cross-window discovery cannot assume. So it works from any cwd, with zero live bridges, and with no bridge reachable at all. This is also why it is the answer to `list`'s cwd-dependence: an empty `list` means "cwd outside a known workspace", an empty `agents` means "no windows are up".

One file per live window is written at `~/.vscode-terminal-bridge/bridges/<id>.json` on activation (rewritten when workspace folders change) and removed on clean deactivation. A [headless bridge](#discovery) also puts its entry back if it goes missing. `id` is a fresh UUID per activation, deliberately not persisted across reloads: a reloaded window is a new process with a new pid, and a reused id would let a stale entry's pid check pass by accident.

**Reaping is fail-closed**, matching [`pidAlive`/`agentAlive`](#timestamps-and-liveness): an entry is removed only on a *confirmed*-dead pid, never on a stale heartbeat. An unresolvable pid is reported and left in place. The bridge does not derive "abandoned" from heartbeat age — it reports the timestamps and lets you pick a threshold, the same rule that applies to terminals.

The legacy single `~/.vscode-terminal-bridge/port` file is still written alongside the registry for existing callers. It is deprecated for cross-window discovery, not removed.

**Presence only — agent-to-agent messaging is deliberately out of scope.** `send`/`nudge` still target bridge-managed terminals within the calling window's own bridge. Knowing another window is up is not a channel into it.

---

### `GET /reindex`

Manually triggers a re-index scan. Useful right after a **Developer: Reload Window** before the window has received focus, or from a startup script that wants to confirm the registry is populated.

```bash
curl http://127.0.0.1:$PORT/reindex
# {"ok":true,"reindexed":3}
```

The `reindexed` count is the number of terminals newly linked in this call (0 if everything was already tracked).

*v0.28.0+ ([#64](https://github.com/solcarty/vscode-terminal-bridge/issues/64)).* Re-index only **fills** a name: one that is unbound, or whose terminal has closed. It never moves a name off a terminal that is still open, so a new tab or VS Code task terminal opened at a tracked terminal's cwd can't take that name over. A terminal is matched to a persisted name by its tab name first, then by its shell-integration cwd, then by git worktree basename, with these guards:

- **Several names share the cwd** (e.g. tabs opened at a repo root): no cwd match unless the terminal's shell pid equals exactly one of those rows' recorded `pid`.
- **The row's recorded `pid` is alive and isn't this terminal's shell:** no match. That process belongs to some other terminal. A dead or missing recorded pid proves nothing (a full restart revives tabs under new pids), so it doesn't block a match.

Closing a tab removes only the name bound to that tab. Closing an untracked tab removes nothing.

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
| `icon` | No | Tab icon — a codicon id (e.g. `hubot`, `check`, `error`, `sync~spin`): it must match `[a-z0-9-]+(~spin)?`. Set once at creation to mark the terminal's identity. Anything else (an emoji, a `$(…)` string) is ignored and echoed back as `iconIgnored`; the terminal still opens, with no icon. |
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
{ "ok": true, "name": "my-tab", "cwd": "/path/to/dir", "cmd": "echo hello", "color": null, "icon": null, "reused": false, "delivery": "pending" }
```

With an `icon` that isn't a codicon id, the response carries `"icon"` unset and `"iconIgnored": "<what you passed>"` (v0.30.0+). VS Code would otherwise print it in the tab as literal `$(🛰️)` text.

The bundled `bridgectl.sh open` client checks this response and returns a non-zero exit code (printing the error to stderr) if the bridge couldn't be reached or reported failure — it no longer swallows every error with a blind `|| true`. It waits up to 10 s for the bridge (2 s before v0.30.0), and prints a stderr warning, exit still 0, when the response reports `iconIgnored`.

#### `open` is idempotent by name, and the response is not a delivery claim

**Idempotent by name (#53).** A client that times out (`curl`'s own timeout is shorter than the shell-integration fallback below) and retries used to leave **two** tabs against **one** registry row — the first an orphan `list` can't see and `close`/`sweep` can't target, and if the timed-out attempt also ran `cmd`, two agents on one worktree branch. Now, if `name` is already tracked *and* its terminal is still live in the window, `open` hands back the existing tab and runs nothing further: `reused: true`, `delivery: "skipped-reused"` — the command is deliberately **not** re-run, since an agent may already be working in a reused tab and relaunching over it is exactly the destructive shape this exists to prevent. A tracked name whose terminal is gone (a stale row) still creates fresh, as before.

**Overlapping opens (v0.30.0+).** `open` claims `name` before it does anything that can wait, including the `node=` round-trip and `createTerminal`. A second `open` for a name another open is still creating waits for that one to finish, then gets its terminal back with `reused: true`; it never creates a second tab, and with `node=` it never starts a second remote job. If the first open fails and creates nothing, the waiting one creates the terminal itself.

**The response is not a claim the command ran (#52).** `open` used to answer `ok: true` before `cmd` had even been attempted, so a caller couldn't tell a launch that ran its command from one that left a bare shell — every field on the tab (`live`, `pidAlive`) looks healthy either way, because the shell really is running. The immediate response's `delivery` is one of `pending` (a fresh tab — outcome not known yet), `skipped-reused` (see above), or `none` (no `cmd` given). The real outcome lands on the `/list` row as `cmdDelivery` / `cmdDeliveredAt`:

| `cmdDelivery` | Meaning |
|---|---|
| `shell-integration` | The shell reported ready, then the command was written. Confirmed. |
| `prompt` | [Headless](#headless-mode-no-vs-code-window) only: the tmux pane's cursor sat after a prompt, then the command was written. Confirmed the same way. |
| `timeout` | The ready signal never arrived; written blind after a fallback delay. The write happened — whether the shell consumed it is unknown. |
| `none` | Nothing to deliver. |
| `null` | Rows from before v0.25.0, or a tab that hasn't reached either outcome yet. |

`open` still answers immediately rather than blocking on delivery — the blind fallback is longer than the client timeout that caused #53 in the first place, so waiting would trade one bug for the other. Poll `/list`'s `cmdDelivery` when certainty matters.

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
      "pid": 12345, "live": true, "pidAlive": true, "agentAlive": true,
      "createdAt": "2026-08-05T09:14:02.881Z",
      "updatedAt": "2026-08-05T11:52:04.019Z",
      "statusChangedAt": "2026-08-05T09:14:11.226Z",
      "lastHeartbeatAt": "2026-08-05T11:52:04.019Z",
      "cmdDelivery": "shell-integration",
      "cmdDeliveredAt": "2026-08-05T09:14:03.302Z",
      "lastSendAt": "2026-08-05T11:51:58.004Z",
      "lastSendDelivery": "submitted",
      "pendingTasks": 1, "bgTask": true,
      "bgTaskStartedAt": "2026-08-05T11:44:30.007Z",
      "displayStatus": "bg-task",
      "noteUpdatedAt": "2026-08-05T11:50:12.771Z",
      "noteBytes": 128, "noteTruncated": false,
      "lastOutputAt": "2026-08-05T11:51:02.310Z", "outputCount": 3,
      "prUrl": "https://github.com/solcarty/vscode-terminal-bridge/pull/50",
      "prSetAt": "2026-08-05T11:53:00.001Z"
    }
  ]
}
```

*v0.33.0+.* The response also carries `backend` (`vscode` or `tmux`), and on a [headless bridge](#headless-mode-no-vs-code-window) each row carries `tmuxSession`: the session to attach to (`tmux -L vscode-bridge attach -t =<session>`), or `null` when the row has no live session. Every other field means the same thing on both backends; `pidAlive` and `agentAlive` read the pane's shell exactly as they read a VS Code tab's.

#### Timestamps and liveness

Status alone answers "what state is this in". The question an orchestrator actually has is *does this need me right now* — and a terminal at `needs-input` for two minutes and one at `needs-input` for two hours are the same row without a clock.

| Field | Moves when |
|---|---|
| `createdAt` | Terminal first tracked. Never advances afterwards. |
| `updatedAt` | Any metadata write — status, rename, pid, color. |
| `statusChangedAt` | The status **value** changes. A `PreToolUse` hook firing `status=working` every few seconds does *not* reset it, or "how long has this been working" becomes unanswerable. |
| `lastHeartbeatAt` | **Any** `/rename-terminal` call lands, including the idempotent no-ops. |
| `cmdDeliveredAt` | `open`'s startup command is actually written to the shell — see [`cmdDelivery`](#open-is-idempotent-by-name-and-the-response-is-not-a-delivery-claim) (v0.25.0+). |
| `lastSendAt` | A `/send-text` call **submits** text into this terminal (v0.20.0+), or a `/nudge-terminal` lands (v0.24.0+). Staged text (`submit=0`) and refused sends don't stamp. |
| `lastSendDelivery` | Written alongside `lastSendAt` (v0.24.0+): `submitted` \| `submit-unverified` \| `nudge`. Not a timestamp — it's *how much* the last write can be trusted; see [below](#get-list). |
| `bgTaskStartedAt` | `pendingTasks` goes from 0 to 1 (v0.21.0+). Cleared when the count returns to 0, so it can't outlive the work it described. |
| `lastOutputAt` | A Stop hook publishes the turn's final assistant text (v0.23.0+). Bodies come from [`/output`](#get-set-output--get-output--get-clear-output), never from `/list`. |
| `noteUpdatedAt` | A worker publishes a note via `/set-note` (v0.22.0+). The **body is not in `/list`** — fetch it from [`/note`](#get-set-note--get-note--get-clear-note) for the entries whose timestamp moved. |
| `prSetAt` | A caller sets `prUrl` via [`/set-pr`](#get-set-pr) (v0.25.0+). Last write wins. |

`pendingTasks` / `bgTask` / `displayStatus` carry the background-work dimension — see [`/bg-task`](#get-bg-task) for why that is separate from `status`. `status` remains the raw turn state; `displayStatus` is what the tab renders.

`now` is the bridge's clock at response time, so callers compute ages against it rather than their own.

**Why `lastHeartbeatAt` is separate from `statusChangedAt`.** Status is *self-reported*: it says what the agent last announced, not what's true now. A subagent spinning on no-op calls and a subagent making real progress both report `working` indefinitely. `live` doesn't close the gap either — it only asserts the VS Code terminal object exists, which stays true around a crashed or hung process. The heartbeat is the independent signal: it advances on the repeat hook calls that sustained work generates, so `working` with a 40-minute-old heartbeat is a wedged agent, not a busy one.

**The bridge never derives status from staleness.** No auto-flip to `error` after N minutes — a build legitimately runs quiet for 20. Only the caller knows where its threshold sits, so this reports facts and stops there.

**`pidAlive` is narrower than it looks.** The tracked pid is the terminal's *shell*, not the agent inside it, and a crashed `claude` usually drops back to a live shell prompt — so `pidAlive` stays `true`. It catches the tab-is-gone case cheaply; `lastHeartbeatAt` is what distinguishes wedged from working.

**`pidAlive: null` means unknown, never dead (#54, v0.25.0+).** Every `/list` call now re-resolves each tracked terminal's own shell pid live, rather than trusting the value persisted at creation — that persisted pid can be a transient child captured before the shell settled, and once *that* process exits, `pidAlive` used to read `false` forever for a terminal whose shell (and agent) were both fine. A caller following the obvious reaction to "dead" — relaunch — would then start a second agent on a worktree that already had one, which is the exact #53 shape #52/#53 exist to prevent. Resolution is best-effort and time-boxed (250ms) so a slow read never blocks `/list`; an unresolved pid reports `pidAlive: null`, not `false`. **Any consumer doing a bare `if (!pidAlive)` truthiness check now treats "unknown" the same as "dead" — check for `=== false` explicitly.** A corrected pid is persisted as a side effect, so `close`/`sweep` stop aiming at a pid that was never the shell's.

**`agentAlive` answers what `pidAlive` structurally cannot (house.health#4589).** A finished worker, a worker blocked on a question, and a bare shell left behind by a crashed agent all read `pidAlive: true`, because that field only proves the *shell* exists. `agentAlive` checks whether that shell has a live descendant process whose command matches `claude` — the same `pgrep -P <pid>` triage a caller would otherwise reimplement by hand (and the one worth getting right: on the tracked shell pid alone, `ps -p <pid> -o command=` always reads `/bin/zsh -il` for a healthy tab, agent alive or not — check the *child*, not the tracked pid). Same fail-closed contract as `pidAlive`: `null` means unknown, not dead, and only ever appears for a shell that couldn't be resolved or a `pgrep`/`ps` read that timed out (also time-boxed at 250ms). A shell already confirmed dead reports `agentAlive: false` directly, without spending a child-process check on it. **This does not prove the agent is doing anything** — a wedged agent's process is still alive, so pair `agentAlive` with `lastHeartbeatAt` the same way `pidAlive` needs it.

**`lastSendAt` is how you confirm a send was picked up.** `/send-text` returning 200 means the text was *written* to the terminal, not read — `sendText` queues in the buffer. Comparing the two timestamps answers what the exit code can't:

| Observation | Means |
|---|---|
| `lastHeartbeatAt` < `lastSendAt` | Delivered, not yet picked up |
| `lastHeartbeatAt` > `lastSendAt` | Picked up — the agent has done something since your text landed |
| `lastSendAt` is `null` | Nothing was ever sent |

Watching for a status *transition* instead doesn't work: hooks fire on tool calls, so an agent that reasons for a while before acting still reads `needs-input` long after your text landed — and a transition that does happen can't be attributed to your send rather than to the agent acting on its own. A heartbeat *after* your send is attributable in a way a bare status change never is.

**`lastSendDelivery` tells you how much `lastSendAt` is worth.** The comparison above assumes the text was actually submitted. On the bracketed-paste path that isn't a safe assumption — a TUI collapses a large paste into a `[Pasted text #N +M lines]` placeholder, and against a busy target the Enter can be discarded rather than buffered, leaving the message parked in the input box where waiting will never consume it ([#48](https://github.com/solcarty/vscode-terminal-bridge/issues/48)). VS Code exposes no read side for a terminal, so the bridge cannot see which happened — it records which path was taken and lets you act on that:

| `lastSendDelivery` | Meaning |
|---|---|
| `submitted` | Direct path (single-line / `literal` / `join`): text and Enter written back to back, no placeholder in between. |
| `submit-unverified` | Paste path: the Enter was written after a delay, but whether the input widget took it is unobservable. |
| `nudge` | The last write was a bare Enter from [`/nudge-terminal`](#get-nudge-terminal), not a message. |

**`submit-unverified` + `lastHeartbeatAt` older than `lastSendAt` is the stranded-message signature** — and it's distinguishable from an agent that is merely busy, which was the gap: both look identical through `status` and the heartbeat alone. `/nudge-terminal` is the fix; re-sending the text would duplicate it if the paste did in fact land.

**Entries predating a field's release report `null`** rather than a fabricated value — the four v0.18.0 timestamps on older entries, `lastSendAt` on any terminal that hasn't been sent to, and `lastSendDelivery` on rows last written by a pre-v0.24.0 bridge. Treat `null` as unknown, not as zero.

Or via the bundled client: `bash ~/.vscode-terminal-bridge/bin/bridgectl.sh list`.

---

### `GET /send-text`

Injects text into an **already-running** tracked terminal. `/open-terminal`'s `cmd` only fires at spawn, so before this the only way to get a message into a live agent session was a close + re-open — which restarts it and loses its in-memory context. This delivers to the session that's already there.

| Param | Default | Meaning |
|-------|---------|---------|
| `name` | — | Tracked terminal name (required) |
| `text` | — | Inline payload |
| `textFile` | — | Absolute path to a file whose **contents** are injected |
| `submit` | `1` | `0` stages the text without sending a newline |
| `force` | `0` | `1` sends even when the terminal is at an interactive prompt |
| `mode` | `auto` | `auto` \| `paste` \| `literal` \| `join` |
| `submitDelayMs` | `250` on the paste path, `0` otherwise | ms to wait between the paste and its Enter (v0.24.0+) |

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
{ "ok": true, "name": "my-task", "status": "working", "submitted": true,
  "delivery": "submit-unverified", "submitDelayMs": 250, "mode": "paste", "bytes": 412,
  "lastSendAt": "2026-08-05T11:51:58.004Z" }
```

**`textFile` is not `/open-terminal`'s `cmdFile`.** `cmdFile` turns into `bash <file>` — it *runs* the file, which is meaningful against a fresh shell prompt and meaningless against a live TUI. `textFile` reads the file and injects its contents as typed text. Use it for anything multi-line, quote-heavy, or long enough to strain an inline GET URL. Trailing newlines are stripped so the payload doesn't submit itself before `submit` does.

**Newlines and `mode`.** VS Code's `sendText` writes text as though typed, so in a TUI every embedded `\n` acts as Enter — a three-paragraph message would submit paragraph 1 as a complete turn and the rest as separate, contextless ones. So multi-line payloads are wrapped in bracketed paste (`ESC[200~ … ESC[201~`) and submitted once, the same mechanism that makes pasting multi-line text by hand work. Single-line payloads skip the wrapper entirely, so there are no escape sequences to leak on a target that doesn't honour bracketed paste.

- `auto` (default) — paste-wrap only when the payload has newlines
- `paste` — always wrap
- `literal` — never wrap (raw `sendText`)
- `join` — collapse interior newlines to spaces, delivering one line. The fallback if a particular target turns out not to honour bracketed paste.

**Prompt-state safety.** Text injected while the target sits at a permission dialog or a numbered question is consumed as *an answer to that menu*, not read as a message. `/send-text` returns **409** when the tracked status is `needs-input` or `permission`; pass `force=1` when answering the prompt is what you actually mean. Unknown or non-live terminal → **404**.

**Exit 0 means delivered, not received.** `sendText` queues in the terminal buffer when the target is mid-execution, so a successful response says the text was written — not that the agent read it or acted on it. To confirm pickup, compare `lastHeartbeatAt` against `lastSendAt` in `/list`: a heartbeat *after* your send means the agent has acted since your text landed (v0.20.0+). Don't watch for a status transition instead — hooks fire on tool calls, so a status can lag a pickup by minutes, and a transition that does occur can't be attributed to your send.

**`delivery` says which of those two things "written" means.** `submitted: true` only ever meant *an Enter was written*, and on the paste path that is weaker than it reads: the TUI collapses a large paste into a `[Pasted text #N +M lines]` placeholder, registering the placeholder is asynchronous, and an Enter that arrives mid-turn can be dropped rather than buffered — so the message sits in the input box indefinitely and no amount of patience moves it ([#48](https://github.com/solcarty/vscode-terminal-bridge/issues/48)). Two changes follow:

- The submit is now written `submitDelayMs` after the paste (default 250ms) so the placeholder has time to register. Raise it for a slow target; `submitDelayMs=0` restores the pre-v0.24.0 timing.
- The response reports `delivery` — `submitted` on the direct path, `submit-unverified` on the paste path, `staged` for `submit=0`. `submitted` is kept for older callers but read `delivery` instead. It is also persisted to `/list` as `lastSendDelivery`, so an orchestrator polling one endpoint sees the difference.

If a `submit-unverified` send is followed by no heartbeat, the message is probably stranded — send a bare Enter with [`/nudge-terminal`](#get-nudge-terminal) rather than re-sending the text, which would duplicate it if the paste did land. `mode=join` sidesteps the placeholder path entirely, at the cost of collapsing the payload onto one line.

Or via the bundled client:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send my-task "rebase onto main and re-run /pre-pr"
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send my-task --text-file=/tmp/msg.txt
```

Note this closes only the orchestrator→agent half of the loop. Reading a terminal's output back is a separate problem with no stable VS Code API — tracked in [#32](https://github.com/solcarty/vscode-terminal-bridge/issues/32).

---

### `GET /nudge-terminal`

Sends a **bare Enter** into a tracked terminal — no text. The recovery path for a `submit-unverified` send whose payload is sitting unread in the target's input box ([#48](https://github.com/solcarty/vscode-terminal-bridge/issues/48)).

| Param | Default | Meaning |
|-------|---------|---------|
| `name` | — | Tracked terminal name (required) |
| `force` | `0` | `1` sends even when the terminal is at an interactive prompt |

```bash
curl -G "http://127.0.0.1:${PORT}/nudge-terminal" --data-urlencode "name=my-task"
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh nudge my-task
```

```json
{ "ok": true, "name": "my-task", "status": "working", "delivery": "nudge",
  "lastSendAt": "2026-08-05T11:57:10.221Z" }
```

**Why this isn't automatic.** A blind second Enter on a target that *did* consume the first one is an empty submit — harmless in most TUIs, promised by none. Whether that risk beats leaving a message stranded depends on what was sent, which is the caller's knowledge and not the bridge's. Same 409 refusal as `/send-text` when the tracked status is `needs-input` or `permission`, for a sharper reason: Enter at a menu selects whatever is highlighted.

It stamps `lastSendAt` and sets `lastSendDelivery` to `nudge`, so the pickup comparison keeps working after a nudge — a heartbeat later than the nudge is the agent acting on the message it just released.

Refused with **400** on a headless worker (below): it has no input box, and inbox sends never strand.

---

### Headless workers: `bridgectl worker`

*v0.26.0+ ([#59](https://github.com/solcarty/vscode-terminal-bridge/issues/59)).* Most of `/send-text`'s machinery — bracketed paste, `submit-unverified`, `nudge`, the 409 at a prompt — exists because an orchestrator talks to a TUI by typing into it. When no human needs to type into the tab, `bridgectl worker` drives the agent over its structured stream-json channel instead, from **inside** a tracked terminal, so the tab, its icon and its `/list` row all stay:

```bash
# the tab's startup command (e.g. via open --cmd-file=<kickoff>)
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh worker \
  --prompt-file=/path/to/kickoff.md --permission-mode=auto --permission-policy=/path/to/policy.json
```

which runs, for the `claude` backend:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --session-id <uuid> [--permission-mode <mode>] --permission-prompt-tool stdio [--model <m>]
```

| Option | Meaning |
|--------|---------|
| `--prompt=` / `--prompt-file=` | First message. Without one, the worker starts `idle` and waits for its inbox |
| `--name=` | Tab to report to (default `$CLAUDE_TAB_NAME`, which the bridge sets on every tab it opens) |
| `--cwd=` | Working directory (default: the shell's) |
| `--permission-mode=`, `--model=` | Passed to the agent |
| `--permission-policy=` | Allowlist file, below. Without one, every prompt the agent's own settings don't decide is escalated |
| `--resume` | Resume the session in `.bridge-worker/session` instead of starting a new one |
| `--backend=` | Agent backend (`claude`). Pluggable, like `scaffold --backend` |
| `--agent-cmd=` | Swap only the executable (a pinned binary, a wrapper script); the backend's arguments are kept |
| `-- <args>` | Extra arguments appended to the agent's command line |

**What it does.**

- **One worker per cwd.** `<cwd>/.bridge-worker/lock` is created exclusively; a second `bridgectl worker` in the same cwd exits **3** naming the running one. A lock whose pid is gone (a wrapper killed with `-9`) is stale and the next worker takes it over. This closes the double-agent shape at the source rather than trusting every caller to check first.
- **Inbox.** `<cwd>/.bridge-worker/inbox.sock`, a unix socket. Each message received is written to the agent's stdin as a stream-json `user` message. A message that arrives mid-turn is queued in the agent's own input and read without interrupting the running tool.
- **The wrapper is the single writer to the agent's stdin.** Never run `claude -p --resume <id>` against a live worker's session: a second writer on the same session interrupts the worker's in-flight tool call.
- **Reports from real events, not self-report.** A `tool_use` → `status=working`; a `result` event → `status=idle` and the result text published through [`/set-output`](#get-set-output--get-output--get-clear-output); every event stamps the heartbeat (via `/heartbeat`, at most once a second), so a silent stream is a wedged agent; the agent exiting on its own → `status=error` with the exit code and the takeover command in a note. A stop you asked for (Ctrl-C in the tab, `SIGTERM` to the wrapper) is reported as `idle` with a "stopped on request" note instead. The agent runs with `VSCODE_BRIDGE_WORKER=1`, which makes `hook-status` and `hook-output` stand down, so its own hooks don't write a second, self-reported status to the same row.
- **Renders the stream** readably in the tab — assistant text, one line per tool call, turn ends, permission prompts. Read-only: the wrapper doesn't read typed input.
- `.bridge-worker/` writes its own `.gitignore`.

**`/send-text` and `/list`.** When a tracked terminal's cwd holds a live worker lock, `/list` reports it as `mode: "headless"` (with `workerPid` and `sessionId`; `mode: "terminal"` otherwise), and `/send-text` delivers to the inbox:

```json
{ "ok": true, "name": "my-task", "status": "working", "submitted": true,
  "delivery": "inbox", "mode": "inbox", "queued": true, "bytes": 38,
  "lastSendAt": "2026-09-11T14:02:11.418Z" }
```

`queued: true` means the agent was mid-turn. There is no 409 on status — nothing typed can be read as an answer to a menu — except while a permission request is outstanding (`error: "permission-pending"`, with the request in `pending`); answer it first, or pass `force=1` to queue the message behind it anyway. `submit=0` is refused (400): there is no input box to stage into. If the socket is unreachable the send fails (503) rather than falling back to typing into a tab that isn't listening. Terminals without a worker are untouched: same paste path, same responses.

**Permission prompts.** With `--permission-prompt-tool stdio`, anything the agent's own settings don't already allow or deny arrives at the wrapper as a `control_request`/`can_use_tool` event and is answered on the agent's stdin. (The agent's settings are consulted first — a tool its `settings.json` allows never reaches the policy.) The wrapper checks the policy file; anything it doesn't decide sets `status=permission` and waits:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh worker pending my-task
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh worker answer my-task allow
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh worker answer my-task deny --message="use the staging db"
# or: GET /worker-permission?name=my-task[&behavior=allow|deny][&message=...][&requestId=...]
```

`requestId` is only needed when more than one request is pending. Answering with nothing pending is a 404.

**Policy file format.** JSON, re-read on every prompt so edits apply to a running worker:

```json
{
  "allow": ["Read", "Grep", "Glob", "Bash(git status:*)", "Edit(/repo/src/*)", "mcp__github__*"],
  "deny":  ["Bash(rm:*)"]
}
```

- A rule is `Tool` or `Tool(spec)`. `Tool` may use `*` (`mcp__github__*`).
- `spec` is matched against the tool's subject — the first of `command`, `file_path`, `notebook_path`, `path`, `url`, `pattern` in its input. `*` matches anything; a trailing `:*` means "this command, optionally followed by arguments".
- `deny` is checked before `allow`. Neither → escalated.
- **Bash is the one tool where a string match isn't a safety property.** An `allow` rule with a spec never matches a command containing shell operators (`; & | $ ( ) < >`, backticks, newlines) — `Bash(git status:*)` does not allow `git status; rm -rf ~`; that escalates. A bare `Bash` rule still allows everything, because that's what it says. `deny` rules match if any segment of a compound command matches.
- An invalid file exits the worker with **2** at startup. A file that stops parsing mid-run fails closed: prompts escalate, never auto-allow.

The bridge ships the mechanism only; what goes in the allowlist, and who answers escalations, belongs to the consumer.

**Takeover.** Stop the wrapper (Ctrl-C in the tab), then in the same tab:

```bash
claude --resume "$(cat .bridge-worker/session)"
```

or restart it headless with `bridgectl worker --resume`. Never resume while the wrapper is still running.

**Limits.** The inbox is a unix socket, and socket paths are capped near 104 bytes. When `<cwd>/.bridge-worker/inbox.sock` would be longer, the socket goes in the OS temp dir instead (`bridge-worker-<hash of cwd>.sock`); the lock records wherever it is, and that's what the bridge reads. Needs `node` on the PATH.

---

### `GET /rename-terminal`

Records a tracked terminal's label, status and color in the bridge's registry, where [`/list`](#get-list) reports them. **It never changes the tab:** a terminal's title, icon and color are what [`/open-terminal`](#get-open-terminal) created it with, for its whole life (v0.29.0+, see [below](#tab-titles-icons-and-colors-are-fixed-at-open)). Supports three modes.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name (as passed to `/open-terminal`) |
| `status` | No* | Canonical lifecycle state. The bridge stores it, plus a label carrying the matching codicon prefix and the matching color. See [status values](#status-values) below. |
| `label` | No* | Full label override. When combined with `status=`, updates the base label and re-applies the status prefix on top. *Required if neither `status=` nor `quiet=1` is provided.* |
| `color` | No | VS Code ThemeColor ID override for the stored color. Takes precedence over the status default color. |
| `icon` | No | Accepted and echoed back for compatibility. Has no effect. |
| `quiet` | No | `quiet=1` — store only status and/or color. The stored label is not changed. |

**Three modes:**

- **Status mode** (`status=<key>`) — the bridge looks up the canonical codicon + color for the given state, stores the label as `$(codicon) baseLabel`, and stores the color. Idempotent: repeated calls with the same status value are no-ops if the label and color are already stored.
- **Quiet mode** (`quiet=1`) — stores status and/or color (including the status color when `status=` is combined). Label is not changed.
- **Legacy mode** (`label=<text>`) — stores the full label verbatim (e.g. a loop's `feat-12 3/1/4 next 16:10`).

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
| `bg-task` | `$(server-process)` | blue | `TaskCreated` — **routed to the background-work dimension**, see below. Prefer `/bg-task?op=start` |
| `task-done` | `$(check-all)` | green | `TaskCompleted` — decrements the background count when work is outstanding; otherwise a sticky "go look at this" badge |
| `pr-open` | `$(pass-filled)` | green | After `gh pr create` |
| `merged` | `$(git-merge)` | magenta | After merge |
| `none` | *(strip prefix)* | *(unchanged)* | Manual reset |

```bash
PORT=$(cat "$PWD/.vscode-bridge-port" 2>/dev/null || echo 31415)

# Status mode — bridge handles codicon + color (idempotent)
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=working"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=needs-input"
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&status=idle"

# Quiet + status — status and color only, label unchanged
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&quiet=1&status=working"

# Legacy label override
curl "http://127.0.0.1:${PORT}/rename-terminal?name=my-task&label=my-task%20done&color=terminal.ansiGreen"

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
  "status": "working",
  "applied": true
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
  "noOp": true,
  "applied": true
}
```

Returns `404` if the terminal is not in the registry (e.g. opened before the last reload).

`applied` is always `true` since v0.29.0: there is no tab write left to skip. It stays in the response (and in `/bg-task`'s) so the shape callers parse is unchanged. Before v0.29.0 it could be `false` with `reason: "not-active"`.

#### Tab titles, icons and colors are fixed at open

A terminal's title is the `name` it was opened with, and the bridge never renames it. Its icon and color are the `icon`/`color` passed to `/open-terminal`, and nothing changes them afterwards. Read a terminal's current state from `/list` (`label`, `status`, `displayStatus`, `color`) or the [side panel](#the-terminal-bridge-side-panel), not from the tab.

Why the title can't follow status: VS Code can only rename the **active** terminal (`workbench.action.terminal.renameWithArg`). Up to v0.28.x every status change switched to the target tab, renamed it and switched back, and with many agents changing status at once, renames landed on whichever tab was active, so tabs wore each other's titles.

Why the icon and color can't follow status either: **VS Code does not apply an icon or color change to an existing terminal, active or inactive.** The `vscode.Terminal` object an extension holds has no `iconPath` or `color` member, only read-only getters (`name`, `processId`, `creationOptions`, `exitStatus`, `state`, `selection`, `shellIntegration`, `dimensions`) and `sendText`/`show`/`hide`/`dispose`. `creationOptions` is frozen. Assigning `terminal.iconPath` or `terminal.color` adds a plain property nothing reads, and no message reaches the window; icon and color only travel with `createTerminal`. This was checked against the extension host shipped in VS Code Insiders 1.142.0 (`out/vs/workbench/api/node/extensionHostProcess.js`), not by toggling a live tab: the bridge in use couldn't be reloaded, and the source leaves no path by which an assignment could take effect. Earlier versions' `quiet=1` and post-rename color assignments therefore never changed a tab.

---

### `GET /repaint`

Kept so callers of the route and `bridgectl repaint` don't break, but since v0.29.0 there is nothing to redraw: titles are fixed at open. It changes nothing and reports every tracked, open terminal as skipped, with its stored label.

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh repaint
curl http://127.0.0.1:$PORT/repaint
# {"ok":true,"repainted":0,"skipped":5,"terminals":[{"name":"w1","label":"$(loading~spin) w1","applied":false,"reason":"titles-fixed"}, ...]}
```

---

### `GET /set-output` · `GET /output` · `GET /clear-output`

Read-back: what the agent in a tracked terminal last **said**, so an orchestrating session can learn the outcome of work it delegated without a human copy-pasting it back.

| Endpoint | Parameters | Purpose |
| -------- | ---------- | ------- |
| `/set-output` | `name` (req), `text=` or `textFile=` | Publish a turn's final assistant text (called by a hook, not by hand) |
| `/output` | `name` (req), `n=` (1–3, default 1) | Read the most recent message(s) back |
| `/output?pane=1` | `name` (req), `lines=` (default 50) | [Headless](#headless-mode-no-vs-code-window) only (v0.33.0+): what the tmux pane shows now, via `capture-pane` → `{ ok, name, lines, pane }`. A VS Code bridge answers `501`, because VS Code has no way to read a terminal. |
| `/clear-output` | `name` (req) | Drop what's stored |

```bash
bridgectl output my-task          # most recent message
bridgectl output my-task --n=3    # the last three
```

```json
{
  "ok": true, "name": "my-task",
  "outputs": [{ "at": "2026-08-19T15:02:11.004Z", "text": "Root cause: …\nFix here or split it?", "truncated": false }],
  "lastOutputAt": "2026-08-19T15:02:11.004Z",
  "available": 3, "maxEntries": 3
}
```

#### How it works — and what it deliberately isn't

There is no stable VS Code API for reading a terminal's buffer: `onDidWriteTerminalData` is proposed-API only, and the shell-integration APIs model discrete shell commands rather than a long-running TUI like a `claude` session. So this doesn't read the terminal at all — it reuses the hook plumbing that already populates `status`:

```json
"Stop": [{ "hooks": [
  { "type": "command", "command": "bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status idle" },
  { "type": "command", "command": "bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-output" }
]}]
```

`hook-output` reads **`last_assistant_message`** straight from the Stop / SubagentStop payload on stdin. It does **not** tail the transcript at `transcript_path`: that file is written asynchronously and can lag the live conversation, and parsing it would couple this extension to Claude Code's on-disk format — which isn't ours and can change under us. Everything the bridge stores is an opaque string it never interprets.

`scaffold --backend claude` emits this wiring.

#### Bounds and failure modes

- **Bounded by construction** — a ring of the last 3 messages, each capped at 4KB. Long messages keep the **tail**, not the head: the conclusion is the part an orchestrator is asking about ("so, PR or split?"). Notes cap the other way round, because a receipts-format note puts its facts first.
- **Degrades to silence, never to an error.** A terminal with nothing to report returns an empty list with a `null` timestamp — "hasn't said anything yet" is a normal state, and a terminal whose hook was never wired must read as quiet rather than broken. A turn that said nothing returns `stored: false`. A malformed payload, a missing field, or a missing `node` makes `hook-output` a no-op that still exits 0, because a hook firing on every Stop must never fail the turn.
- **`/list` carries `lastOutputAt` and `outputCount` only** — bodies come from `/output`, same discipline as notes.
- **Only captures what the hook fires on.** This is the turn's *final* text, not a byte-accurate replay: intermediate reasoning, tool output, and anything printed by a non-agent process in the tab are not here. For those, the terminal itself is still the only source.
- **Remote worker nodes are not covered.** A job on another machine can publish a [note](#notes-from-a-remote-worker-node) over the worker rail, but `hook-output` posts to the local bridge only.

#### Notes vs. output

Both are self-reports, and they answer different questions. A [note](#get-set-note--get-note--get-clear-note) is written *for* the orchestrator — deliberate, structured, checkable. Output is the agent's own words verbatim, which is what catches the case a note can't: the two incidents in [#38](https://github.com/solcarty/vscode-terminal-bridge/issues/38) where a worker's summary was confidently wrong were both caught by reading what it actually said. Poll `/list`, and fetch whichever the timestamps say has changed.

---

### `GET /set-note` · `GET /note` · `GET /clear-note`

A short handoff a worker publishes for its orchestrator to read.

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

Reports **outstanding background work**, which is a dimension of its own — not a `status=` value.

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

#### What `displayStatus` reports

`/list` reports both dimensions raw; `displayStatus` is the derived value the stored `label`'s codicon reflects:

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

`outcome` is the field to branch on:

| `outcome` | HTTP | Means |
| --------- | ---- | ----- |
| `closed` | 200 | A live terminal object was disposed, or its persisted PID was killed |
| `row-removed` | 200 | The terminal and its process were already gone; the tracked row was removed |
| `not-tracked` | 404 | No row under that name — nothing to remove |

`method` refines the `closed` case: `"dispose"` when a live terminal object
was found, `"pid-kill"` when the registry had no object reference and the
persisted shell PID was signalled instead. `row-removed` reports
`"method": "registry"`.

**`close` reconciles the registry, not just the terminal object.**
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

### `GET /set-pr`

Records a PR url against a tracked terminal ([#50](https://github.com/solcarty/vscode-terminal-bridge/issues/50)). Data plumbing only.

| Parameter | Required | Description |
| --------- | -------- | ----------- |
| `name` | Yes | Registry name |
| `url` | Yes | The PR url to store |

```bash
curl "http://127.0.0.1:${PORT}/set-pr?name=my-tab&url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F42"
```

Response:

```json
{ "ok": true, "name": "my-tab", "prUrl": "https://github.com/owner/repo/pull/42", "prSetAt": "2026-08-05T11:53:00.001Z" }
```

`list` reports it back as `prUrl` / `prSetAt`, `null` on rows where it was never set. Idempotent by name: a second call with a different url overwrites (last write wins), same as every other field on the record — no dedicated version-check machinery.

**This is advisory, not a GitHub client.** The bridge does not poll, does not hold a token, and never asserts the PR is still open — `prUrl` may point at something already merged, closed, or force-pushed since it was set. Whoever needs the PR's live state checks it independently; the bridge only remembers what it was told. Unknown `name` → `404`; missing `url` → `400`.

---

### `GET /sweep`

Closes tracked terminals left behind in a removed worktree. It disposes the
terminal, or kills its pid when no live terminal object can be found. A row is
closed only when **all** of these hold (v0.33.3+, #87):

- no git repo the bridge can see lists its `cwd` as a worktree. Repos are found
  from every workspace folder, the sibling `<repo>` of any `<repo>-worktrees`
  folder, and every tracked `cwd`, so worktrees of any repo count.
- its `cwd` no longer exists on disk. A directory that still exists is never
  swept, listed or not.
- its shell has no running child process. A shell still running something, or
  one whose children can't be read, is kept and logged.

Every closed or kept row is logged with its reason. If no repo can be read at
all, the sweep closes nothing.

The bridge runs a **dry run** a few seconds after it starts. It logs what a
sweep would close and closes nothing, so restarting the bridge never kills a
worker. Only an explicit call closes anything.

```bash
curl "http://127.0.0.1:${PORT}/sweep"
curl "http://127.0.0.1:${PORT}/sweep?dryRun=1"   # decide, log and report; close nothing
```

Response:

```json
{ "ok": true, "closed": ["task-a", "task-b"] }
{ "ok": true, "dryRun": true, "closed": [], "wouldClose": ["task-a"] }
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

### `POST /api/status`

Appends a JSON line to `<pipelineStateDir>/pipeline-state.json` in a workspace folder — an append-only log for pipeline/CI state, as opposed to the live tab state everything else here deals with. The directory is [`terminalBridge.pipelineStateDir`](#settings) (default `.sdo`).

```bash
curl -X POST "$VSCODE_BRIDGE_STATUS_URL" \
  -H 'Content-Type: application/json' \
  -d '{"repo":"/Users/you/Workspace/my-repo","stage":"build","state":"green"}'
```

`repo` names which workspace folder the line belongs to; the rest of the payload is yours, stamped with a `ts`. **Send `repo`.** Without it, a multi-root workspace has no way to tell which project a status line is about, so the write falls back to the *first* folder only — it deliberately never fans out to all of them, which is how one project's CI status previously ended up appended inside unrelated sibling repos.

---

## Claude Code hooks

### The pattern

Claude Code fires hook events at key lifecycle points. Each hook runs a shell command; by calling `/rename-terminal` from that command you keep each terminal's status current in the registry, which [`/list`](#get-list) reports, with zero polling. The tab itself keeps the name, icon and color it was opened with ([why](#tab-titles-icons-and-colors-are-fixed-at-open)), so choose them at `/open-terminal` time to say what kind of session the tab is:

```bash
curl ".../open-terminal?name=my-task&icon=hubot&color=terminal.ansiCyan&cmd=..."
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
| `Notification` | Claude needs input (permission prompt, question) | `needs-input` — `hook-status` writes `idle` instead for the ~60 s "waiting for your input" nudge (`notification_type: "idle_prompt"`, or that wording when no type is sent); every other type stays `needs-input` |
| `Stop` | Claude's turn is complete | `idle` — wire `hook-output` here too, see [read-back](#get-set-output--get-output--get-clear-output) |
| `SubagentStop` | A subagent or fork finished | `working` — `hook-status` writes it only while the turn is still running (last state `working`/`subagent`); after `Stop` or during a `permission` prompt it writes nothing (v0.33.2+) |

### Recommended state scheme

Use `status=` for all lifecycle hooks — the bridge owns the codicon + color mapping so every caller automatically gets a consistent look:

| Hook / event | `status=` | Stored `label` | Stored `color` |
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

`status=` never touches the tab. It is also **idempotent**: if `PreToolUse` fires twice in a row while already in `working` state, the second call detects that the label and color are unchanged and returns `noOp: true` (it still stamps `lastHeartbeatAt`).

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

### `hook-status` — one line instead of the template

Every hook script above re-derives the same two things: which port to talk to, and what this terminal is called. `bridgectl hook-status` absorbs both, so a hook becomes one line:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status working
```

It resolves the terminal name from, in order: `--name=<name>` (or a two-arg `<name> <status>` form), `$CLAUDE_TAB_NAME` (exported into every bridge-opened terminal), a `"rootPath"` in a JSON payload on stdin (how Cline passes context — see below), and finally the basename of `$PWD`. It always drains stdin when stdin isn't a tty, so a hook runner writing a payload never blocks on a reader that isn't there. Like `status`, it no-ops silently outside VS Code.

Because it lives in the version-matched copy under `~/.vscode-terminal-bridge/bin/`, the conventions stay current instead of being frozen into each repo's hook scripts at whatever they were on the day those were written. `bridgectl scaffold --backend claude` prints a ready-to-merge `settings.json` snippet using it.

### `scaffold --backend claude --apply` — merge instead of print

The printed snippet documents the **target** state. What an upgrade needs is the **delta** — which of those hooks your `settings.json` is missing — and that is a careful read of a file whose existing hooks may be hand-rolled, matcher-scoped, and working. Getting it wrong either duplicates a status write or silently drops one; upgrading a real install to v0.23.0 came down to a single missing `Stop` entry ([#47](https://github.com/solcarty/vscode-terminal-bridge/issues/47)).

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend claude --apply
#   already-present  PreToolUse     bash .../bridgectl.sh hook-status working
#   added            Stop           bash .../bridgectl.sh hook-output
#   ...
# scaffold --apply: added 1 hook(s) to /Users/you/.claude/settings.json (previous contents saved to ...bak)
```

Defaults to `~/.claude/settings.json` — where this wiring usually lives — with `--settings=<path>` for a project one. What makes it safe to point at a live install:

- **Additive, never replacing.** An existing `Stop` group keeps every hook it has; the scaffolded command is appended as its own group alongside. A group carrying a `matcher` is never inherited into, so the new hook can't be silently narrowed to one tool.
- **Idempotent**, matched on the exact command string — a second run adds nothing and says `already-present` for all 8.
- **Reports per event**, so an unattended upgrade path can log what was actually missing.
- **Refuses on malformed JSON** (and on a `hooks` key of the wrong shape) rather than rewriting it. A `settings.json` that doesn't parse disables every setting in the file, so a partial write is strictly worse than no write. The previous contents are saved to `<settings>.bak` before any modifying write.

The printed snippet and `--apply` render from the same spec, so they can't drift into disagreeing about what a correct install looks like.

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

### Scaffolding the hooks

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

## Implementation patterns

The API reference above says what each endpoint does. This section is the part that is harder to reconstruct from a reference: **how the pieces compose into a working agent system**, and which field makes each step trustworthy.

All of these use `bridgectl` rather than raw `curl` — it handles port discovery, preferring the `VSCODE_BRIDGE_PORT` pinned into a bridge-spawned tab over the racy shared port file, and it is one command per action so a single permission allow-rule covers it.

### Pattern 1: Spawn a worker and know whether it actually started

The orchestrator creates a tab, hands it a kickoff prompt, and walks away. The trap is that **a successful `open` is not proof the agent launched** — `open` answers before the startup command has been attempted, and a tab that came up as a bare shell looks identical to one running an agent, because the shell really is running either way.

```bash
BRIDGE=~/.vscode-terminal-bridge/bin/bridgectl.sh

WORKTREE="$HOME/worktrees/my-repo/task-42"
git worktree add "$WORKTREE" -b task-42

# Attach the worktree to the VS Code workspace — the HTTP equivalent of `code --add`,
# with no `code` CLI required. The extension writes .vscode-bridge-port into it, so
# hooks running inside that folder discover the right window's port.
curl -s "http://127.0.0.1:$(cat "$PWD/.vscode-bridge-port")/add-folder?path=${WORKTREE}"

bash $BRIDGE open task-42 "$WORKTREE" \
  "claude --permission-mode auto --name task-42 'Read MISSION.md and follow it.'" hubot

# The outcome lands on the /list row, not in open's response.
bash $BRIDGE list | jq -r '.terminals[] | select(.name=="task-42") | .cmdDelivery'
```

| `cmdDelivery` | Meaning |
| --- | --- |
| `shell-integration` | Confirmed: the shell accepted the command. |
| `timeout` | Written blind after the fallback delay — the write happened, pickup unknown. |
| `none` / `null` | Not delivered, or not there yet. |

A `timeout` row that never produces a heartbeat is a tab to **look at**, not to relaunch. `open` is idempotent by name: re-opening a live tracked name hands the existing tab back (`reused: true`) and deliberately does *not* re-run the command, precisely because an agent may already be working in it.

Spawn unattended workers with the backend's own non-interactive flag (`--permission-mode auto` for Claude Code). Nobody is sitting at that tab to answer a permission dialog — and a pending dialog also makes `send` refuse to deliver, so the session is stuck in both directions at once.

### Pattern 2: Tell working from wedged from finished

Three fields, none of which is sufficient alone:

```bash
bash $BRIDGE list | python3 -c '
import json, sys, datetime as dt
d = json.load(sys.stdin)
now = dt.datetime.fromisoformat(d["now"].replace("Z", "+00:00"))
for t in d["terminals"]:
    hb = t.get("lastHeartbeatAt")
    age = int((now - dt.datetime.fromisoformat(hb.replace("Z", "+00:00"))).total_seconds()) if hb else None
    print(f"{t[\"name\"]:<12} {t.get(\"displayStatus\"):<12} agentAlive={t.get(\"agentAlive\")} hb_age={age}s")
'
```

- **`status` is self-reported.** A wedged agent and a busy one both say `working` forever.
- **`lastHeartbeatAt` is the independent signal.** It advances on the repeat hook calls sustained work generates, so `working` with a 40-minute-old heartbeat is wedged — but pick your own threshold, because a build legitimately runs quiet for 20 minutes. The bridge deliberately never derives that verdict for you.
- **`agentAlive` answers what `pidAlive` structurally cannot.** `pidAlive` only proves the *shell* exists, and a crashed agent leaves a live shell prompt behind. See [`/list`](#timestamps-and-liveness) for the full contract — including that `null` means unknown, never dead, so a bare `if (!alive)` check is a bug.

**`idle` is ambiguous by construction:** a successfully finished worker and a dead one look the same. Resolve it with `agentAlive` plus the terminal's note or output (Pattern 3), never by relaunching on suspicion — that starts a second agent on a worktree that already has one.

### Pattern 3: Chain work — hand off without a human in the middle

The orchestrator needs the *result*, not just the state. Two read-backs exist for that, and the difference is who writes them:

```bash
# Worker (or its Stop hook) publishes. Both resolve their own tab name from
# VSCODE_BRIDGE_ORCHESTRATOR_ID — no --name needed from inside the tab.
bash $BRIDGE note set --text-file=/tmp/handoff.md   # a deliberate handoff
bash $BRIDGE hook-output                            # the turn's final text, automatically

# Orchestrator reads, then decides what to spawn next.
bash $BRIDGE note get task-42
bash $BRIDGE output task-42 --n=1
```

`/list` carries only `noteUpdatedAt` / `lastOutputAt`, never the bodies — so poll the timestamps across many tabs cheaply, then fetch the one that moved.

Relay a failure back into the session that *created* it rather than re-deriving the fix yourself, and use a file: CI output is multi-line and will not survive inline shell quoting.

```bash
bash $BRIDGE send task-42 --text-file=/tmp/ci-failure.txt
```

Then confirm delivery honestly. `send` exiting 0 means the text was **written**, not read. Compare `lastSendAt` against `lastHeartbeatAt` — a heartbeat *after* your send means the agent has acted since it landed — and check `lastSendDelivery`: `submitted` is confirmed, while `submit-unverified` plus a heartbeat older than the send is the stranded-paste signature, whose fix is `bridgectl nudge` (a bare Enter), never re-sending the text.

### Pattern 4: A manager agent that owns a feature

The shape that scales past one worker: a long-lived **manager** tab owns a unit of work larger than any single agent's context, and spawns, supervises and reaps short-lived workers under it.

```
feature-manager (long-lived, one per feature)
├── spawns task-1, task-2 …            open + cmdDelivery       (Pattern 1)
├── polls them on one list call        heartbeat + agentAlive   (Pattern 2)
├── relays CI failures into the tab    send --text-file         (Pattern 3)
├── reads results back                 note get / output        (Pattern 3)
├── closes each worker when merged     close                    (Pattern 5)
└── opens a review tab at the end, and stops there
```

Why a manager rather than the top-level session doing it: the orchestrator you talk to is the most expensive context in the system, and supervising a feature is a long, repetitive loop. Giving the loop its own tab keeps it out of that context and survives you closing the conversation. **The manager runs as a tracked terminal like any other**, so it reports its own status, publishes its own notes, and can itself be supervised by Pattern 2.

One rule worth encoding: a manager's authority ends at *opening* the next step, never at accepting its result. Ship the gate to a human deliberately rather than letting the loop close on itself.

### Pattern 5: Reap — and the difference between `close` and `forget`

```bash
bash $BRIDGE close  task-42   # disposes the tab AND drops the tracked row
bash $BRIDGE forget task-42   # drops the row only — never touches a process
```

Use `forget` when the process must survive (it's serving something, or you only want the registry tidied). Branch on `close`'s `outcome` field rather than its exit code — `closed`, `not-tracked` and `row-removed` are different facts.

`sweep` disposes tracked terminals whose `cwd` has been removed from disk and is listed by no repo. It won't close a shell that is still running something, but it will close an idle shell whose worktree was removed underneath it. Prefer closing by name at the point you know the work is done. `sweep --dry-run` shows what it would close.

### Pattern 6: Headless work — no TUI to type into

Most of `send`'s machinery — bracketed paste, `submit-unverified`, `nudge` — exists because an orchestrator is typing into a TUI. When nothing needs to be typed by a human, skip the typing entirely: [`bridgectl worker`](#headless-workers-bridgectl-worker) drives the agent over its structured stream-json channel from *inside* a tracked terminal, so the tab, its icon and its `/list` row all still work.

### Pattern 7: Two windows that can see each other

A second VS Code window is a second bridge on a second port, and neither can address the other by cwd. [Presence](#get-announce--get-apibridges) is the discovery layer: each window's main agent announces itself, and any process can read the whole network off disk.

```bash
bash $BRIDGE announce working     # this window's own agent
bash $BRIDGE agents               # every live window, from any cwd
```

Presence is deliberately *not* a channel: knowing another window is up tells you whether to wait, hand something to a shared file, or ask the human — it does not let you inject into it.

### Pattern 8: Non-agent uses

The bridge predates all of the above and is still a plain status board for anything that can make an HTTP request:

```bash
bash $BRIDGE open build "$PWD" "npm run build"

# From the build script itself:
bash $BRIDGE status build working
bash $BRIDGE status build idle      # or: error
```

Prefer `status=` over a hand-written `label=`: the bridge owns the codicon and colour, the update is idempotent, and repeat calls don't reset `statusChangedAt`. Shell-level coverage for tabs you didn't spawn is a `preexec`/`precmd` pair in `~/.zshrc` calling the same two commands.

---

## After a VS Code reload

The extension re-indexes automatically. When the window is focused after a reload it scans all open terminals against persisted metadata and active git worktrees, re-linking any match. You can also call `/reindex` explicitly from a script to force a scan without waiting for window focus. Since v0.28.0 a re-index never takes a name away from a terminal that is still open; see [`GET /reindex`](#get-reindex) for the matching rules.

## Headless mode (no VS Code window)

*v0.33.0+ ([#77](https://github.com/solcarty/vscode-terminal-bridge/issues/77)).* The bridge normally lives inside a VS Code window, so on a remote host it exists only while a Remote-SSH window is connected. Headless mode runs the same bridge as a standalone Node process under systemd, with **tmux sessions** as its terminals. Nothing about the API changes: every route, field and `bridgectl` verb in this README works against it, and `bridgectl.sh` finds it the same way.

### Install

On the host (Linux with systemd, `node` ≥ 18 and `tmux` on `PATH`), from a checkout of this repo:

```bash
bash bin/install-headless.sh --folder="$HOME/Workspace/my-repo" [--folder=...] [--agent-id=dev-1]
```

It copies `bridge.js`, `headless.js` and `bin/` to `~/.vscode-terminal-bridge/headless/app/`, writes `~/.config/systemd/user/vscode-terminal-bridge.service`, enables and starts it, runs `loginctl enable-linger $USER` (so the service starts at boot with nobody logged in), and waits for `/ping` to answer `backend: "tmux"`. Re-run it to upgrade; the restart keeps every tmux session. `--print-unit` prints the unit it would install and changes nothing.

| Option | What it does |
| --- | --- |
| `--folder=<path>` | A workspace folder: gets `.vscode-bridge-port`, is one of the repos `/sweep` reads worktrees from, and is matched by `/api/status`'s `repo`. Repeatable. Also `VSCODE_BRIDGE_FOLDERS` (colon-separated). |
| `--agent-id=<id>` | The [presence](#get-announce--get-apibridges) identity (`terminalBridge.agentId`'s counterpart). Falls back to the first folder's basename. |
| `--socket=<name>` | The tmux socket (`tmux -L <name>`). Default `vscode-bridge`. Also `VSCODE_BRIDGE_TMUX_SOCKET`. |
| `--pipeline-state-dir=<dir>` | `terminalBridge.pipelineStateDir`'s counterpart. |

Without systemd, run it under anything that restarts it: `node headless.js --folder <path>`. Logs go to stdout (`journalctl --user -u vscode-terminal-bridge` under the unit).

### The unit

`systemd/vscode-terminal-bridge.service`: `Restart=always`, `WantedBy=default.target`, the `node` path and `PATH` recorded at install time (systemd's default `PATH` has no nvm or Homebrew node), and **`KillMode=process`**. The tmux server is forked from the bridge, so it sits in the unit's cgroup; the default `KillMode=control-group` would kill every terminal on each restart.

### The tmux backend

- **Each named terminal is a tmux session** on the bridge's own socket (`tmux -L vscode-bridge`), so your own `tmux ls` never sees them and the bridge never touches yours. Session names are the terminal name with anything outside `[A-Za-z0-9_-]` turned into `_` (tmux rewrites `.` and `:` itself); the real name is kept in the `@bridge_name` session option. `/list`'s `tmuxSession` is the session's name.
- **`send`** goes through `tmux load-buffer` + `paste-buffer` (with `-p`, a bracketed paste, on the multi-line path), and the submit is `send-keys Enter`. `delivery` values mean what they always did.
- **`pidAlive` / `agentAlive`** read the pane's shell pid (`#{pane_pid}`) — the same shell-then-`claude`-child check as a VS Code tab.
- **`cmdDelivery`** is `prompt` when the pane's cursor sat after a prompt before the command was written, `timeout` when that never happened within the fallback.
- **`/output?pane=1`** returns what the pane shows (`capture-pane`). The hook-fed `/output` ring works too.
- **To watch or type into one:** `tmux -L vscode-bridge attach -t =<tmuxSession>` (the `=` makes the name exact).
- **`/add-folder` / `/remove-folder`** change the folder list until the next restart; make a folder permanent with `--folder`.

### Lifetime

- **Sessions outlive the bridge.** A stopped or restarted bridge leaves its sessions running; on start it re-reads `tmux list-sessions` and re-binds each row to its session by name, keeping its `createdAt`, status, note and the rest. The registry lives in `~/.vscode-terminal-bridge/headless/registry.json`.
- **A session that ends takes its row with it**, as a closed VS Code tab does. The bridge polls tmux every 2 seconds.
- **After a reboot, terminals do not come back.** The tmux server is gone, so on start the bridge drops every row whose session tmux confirms is gone, and `list` is empty rather than listing terminals that no longer exist. If tmux can't be asked at all, rows are kept until it can.

### Discovery

Exactly the extension's: `~/.vscode-terminal-bridge/port`, `.vscode-bridge-port` in each `--folder`, the bundled CLI in `~/.vscode-terminal-bridge/bin/`, a [presence](#get-announce--get-apibridges) entry in `~/.vscode-terminal-bridge/bridges/` (with `"backend": "tmux"`), and `VSCODE_BRIDGE_PORT` exported into every terminal it opens. Ports start at `31415` as usual.

**It repairs them.** *v0.33.2+ ([#83](https://github.com/solcarty/vscode-terminal-bridge/issues/83)).* Every 30 seconds (`VSCODE_BRIDGE_REPAIR_MS`) the headless bridge checks each folder's `.vscode-bridge-port`, `~/.vscode-terminal-bridge/port` and its presence entry, and rewrites any that is missing or names another port. Each repair logs one line naming the files it rewrote. A healthy check logs nothing. It is the one bridge on its host, so another window's port in one of these files is wrong by definition.

**A bridge removes only its own port files.** *v0.33.2+.* On a clean shutdown the extension and the headless bridge unlink a `.vscode-bridge-port` or `~/.vscode-terminal-bridge/port` only if it still holds their own port. Before v0.33.2, any window closing removed them whatever they held, so an older window on a headless host left the headless bridge running but unreachable.

### Opening a VS Code window on a host that runs headless

The extension does **not** start a second bridge. On activation it looks for a live headless bridge — a presence entry with `"backend": "tmux"`, then `~/.vscode-terminal-bridge/port` — and asks it `/ping`. If one answers `backend: "tmux"`, the window becomes a viewer: no HTTP server, no registry of its own. Its Terminals panel lists the headless bridge's terminals (re-read every 3 seconds; the view's title reads `headless · <port>`), clicking a row opens a VS Code terminal running `tmux attach` on that session (a second click shows the same one), and it writes the headless port into its own workspace folders' `.vscode-bridge-port`. Every caller on the host talks to the one bridge.

If nothing answers, the window serves as it always has. If the headless bridge stops answering later, the view's title says so; reload the window to serve locally.

**Version skew is shown.** *v0.33.2+.* If the headless bridge's `/ping` `version` differs from the window's extension version, the window logs both once and the view's title adds them: `headless · 31415 · headless v0.33.2 ≠ window v0.33.1`. A headless bridge from before v0.33.2 reports no version and reads as `v?`.

### Upgrading

On a headless host **the service is the bridge**. Upgrade it by re-running `bash bin/install-headless.sh …` from an updated checkout: it restarts the service in place, and every tmux session survives. A VS Code window on that host is only a viewer of it, so its extension version affects nothing but the view. Reload the window after installing a new VSIX only if a window is open, and the skew note in the view's title tells you when one is out of date. Hosts are rolled out by `agent-workflows`' host-sync ([house.health#6966](https://github.com/solcarty/house.health/issues/6966)).

## Remote jobs

A long-running job (e.g. a multi-hour local LLM generation) can run on a separate machine on your network — a Mac Mini, a homelab VM, anything reachable over the LAN — instead of blocking your laptop, while still showing up as a normal terminal tab with a live status icon.

This works without VS Code running on the worker machine: `bin/worker.js` is a standalone, dependency-free Node daemon (no `vscode` import) that runs headless under launchd. The laptop's `/open-terminal` gains a `node=` param — when set, instead of running `cmd` in this window, it POSTs the job to the named worker, which:

1. Fetches the configured ref (`ref=`, default `main`) and resolves it to a SHA.
2. Cuts a fresh `git worktree` at that SHA under `<repo>-worktrees/<jobId>` — every job starts from current main, and concurrent jobs never collide with each other.
3. Runs the command inside an [rmux](https://rmux.io/) session (a tmux-compatible, scriptable multiplexer), so the job survives the laptop sleeping or VS Code closing.

The laptop still opens a local terminal tab for the job. That tab doesn't run the job — it runs `bridge-tail.sh <node> <jobId>` (bundled the same way as `bridgectl.sh`), which polls the worker's `/job-status` and reports the job's state via the existing `/rename-terminal?status=` mechanism. The job looks and feels local even though it isn't. After a window reload, any tracked terminal with a `node`/`jobId` in its persisted metadata is reattached automatically if the remote job is still running.

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

## Releasing

Every release on the [Releases](../../releases) page is published by CI when a PR merges to `main`. A PR that changes anything the VSIX ships (everything except `*.md`, `test/**`, `.claude/**` and `.github/**`, per `.vscodeignore`) must bump `version` in `package.json` past the latest `v*` tag: patch for a fix, minor for new behaviour or a new endpoint. The `version-check` workflow fails the PR otherwise. On merge, the `release` workflow tags `v<version>` and attaches `terminal-bridge-<version>.vsix` to a new GitHub Release; a merge whose version is already released publishes nothing.

## Security

The local bridge (`extension.js`, or `headless.js` in headless mode) binds to `127.0.0.1` only — it is **not** accessible from other machines on the network, and has no authentication because it controls only your local VS Code instance.

The worker daemon (`bin/worker.js`, see [Remote jobs](#remote-jobs)) is different: it binds `0.0.0.0` so a laptop on the LAN can reach it, and **does** require a bearer token on every request. Anyone with that token can run arbitrary shell commands on the worker machine — store it like an SSH key (`chmod 600` on `nodes.json`, never commit it).

## License

MIT
