# Claude Code — vscode-terminal-bridge

## What this is

A VS Code extension that exposes a local HTTP API for managing terminal tabs programmatically. Lets external scripts, Claude agents, and shell tools open, rename, close, and set status on named terminals without AppleScript or keystrokes.

Application-agnostic — any repo or process can call it via HTTP. Not coupled to any specific consuming project.

## How it works

- On activation: starts an HTTP server on `127.0.0.1:31415` (increments port if taken)
- Writes the active port to `.vscode-bridge-port` in every workspace folder, and to `~/.vscode-terminal-bridge/port` as a cwd-independent fallback (v0.16.0+)
- Scripts discover their window's port: `PORT=$(cat "$PWD/.vscode-bridge-port")`

## `list` is a query — it fails loudly (v0.16.0+)

`open`/`close`/`status`/`rename`/`sweep` no-op silently when the bridge is unreachable, because hooks call them outside VS Code and shouldn't fail under `set -e`. **`list` does not.** It prints `{"ok":false,"reason":"bridge-unreachable"}` and exits non-zero.

The reason: an empty stdout with exit 0 is indistinguishable from "bridge is up, tracking zero terminals". Anything polling `list` to decide whether an agent terminal is still alive reads that silence as fact, so a dead terminal looks exactly like a healthy empty list. If you consume `list`, **check the exit code** — don't treat empty output as "no terminals".

## `send` talks to a session that's already running (v0.17.0+)

`open`'s `cmd` only fires at spawn, so the only way to get a message into a live agent session used to be close + re-open — which restarts it and throws away its context. `send` delivers into the running session instead. Three things about it are load-bearing:

- **`--text-file` injects file *contents*.** It is not `open --cmd-file`, which turns into `bash <file>` — running a script is meaningless against a live TUI.
- **Multi-line payloads go over as one bracketed paste**, then a single submit. Otherwise every embedded `\n` acts as Enter and a three-paragraph message submits paragraph 1 as a truncated turn. `--mode=join` collapses newlines to one line if a target doesn't honour bracketed paste.
- **It refuses when the tracked status is `needs-input` or `permission`** (409), because text injected at a menu is read as an answer to that menu. `--force` overrides.

Exit 0 means *written to the terminal*, not *read and acted on* — `sendText` queues when the target is mid-execution. Confirm receipt by watching for a status transition via `list`, not by trusting the exit code. Reading a terminal's output back is a separate, unsolved problem (issue #32).

## Key endpoints

All endpoints are GET with query-string params (not POST/JSON — see `extension.js`).

| Endpoint | Purpose |
|----------|---------|
| `/open-terminal` | Open a named terminal in a given cwd (`cmd=` inline, or `cmdFile=` to run a command from a file) |
| `/close-terminal` | Close a named terminal (falls back to PID kill if registry desynced) |
| `/rename-terminal` | Rename / set status icon via `status=` (or `label=`, or `quiet=1`) |
| `/list` | Query tracked terminals (name, cwd, status, pid, live) |
| `/send-text` | Inject text into an already-running tracked terminal (`text=` or `textFile=`) |
| `/sweep` | Dispose terminals whose cwd no longer maps to a live `git worktree` |
| `/add-folder` / `/remove-folder` | Attach/detach a workspace folder |
| `/reindex` | Re-link open terminals to persisted metadata |
| `/ping` | Health check — returns port, pid, workspace folders |

## Calling it — use the bundled CLI, not raw curl

Don't hand-roll curl calls. The extension bundles `bin/vscode-bridge.sh` + `bin/bridgectl.sh` and writes them to `~/.vscode-terminal-bridge/bin/` on every activation, so the calling convention (port discovery, GET param shapes, status-map values) stays in sync with whatever extension version is installed:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open <name> <cwd> [cmd] [icon] [color]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh status <name> <state>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send <name> <text>|--text-file=<path>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh close <name>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status <status> [--name=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend {cline|claude} [--dir=<repo>]
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

## Remote jobs (offloading to a worker node)

A long-running job (e.g. a multi-hour local LLM generation) can run on a separate machine — a Mac Mini, a homelab VM, anything reachable over the LAN — instead of blocking the laptop, while still showing up as a normal terminal tab with a status icon in VS Code.

**How it works:** `bin/worker.js` is a standalone, dependency-free Node daemon — it does **not** depend on `vscode` and runs headless on the worker machine (there's no VS Code window there to host an extension). The laptop's `/open-terminal` gains a `node=` param: instead of running `cmd` locally, it POSTs the job to the named worker, which:
1. Fetches the configured ref (default `main`) and resolves it to a SHA.
2. Cuts a fresh `git worktree` at that SHA under `<repo>-worktrees/<jobId>` — every job is guaranteed to start from current main, and concurrent jobs never collide.
3. Runs the command inside an [rmux](https://rmux.io/) session (a tmux-compatible, scriptable multiplexer), so the job survives the laptop sleeping or VS Code closing.

The laptop still opens a local terminal tab for the job — it runs `bridge-tail.sh <node> <jobId>` instead of the real command, polling the worker's `/job-status` and driving the tab's icon via the existing `/rename-terminal?status=` mechanism. The job looks and feels local even though it isn't. On a window reload, terminals tracked with a `node`/`jobId` in their persisted metadata are reattached automatically if the remote job is still running.

### Setting up a worker node

1. Clone this repo onto the worker machine; this becomes its canonical `WORKER_REPO_DIR`.
2. Generate a token: `openssl rand -hex 32`.
3. Run the daemon with env vars set:

   ```bash
   WORKER_TOKEN=<token> WORKER_REPO_DIR=/path/to/clone node bin/worker.js
   ```

   Put this under launchd (`KeepAlive: true`, `RunAtLoad: true`) so it survives crashes/reboots. `WORKER_PORT` defaults to `31416`.

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

### Job lifecycle / cleanup

- A job's worktree is **auto-removed** on successful completion (`exit code 0`).
- A **failed** job's worktree is left in place for manual inspection — `git worktree remove` it yourself, or `POST /sweep-job?id=<jobId>` to the worker, once you're done debugging.
- To inspect a stuck/running job directly: SSH into the worker and run `rmux attach -t <jobId>`.

## Key file

`extension.js` — the entire extension in one file. No build step required. `bin/worker.js` is the separate, `vscode`-free worker daemon described above.

## Packaging

```bash
npx vsce package   # produces a .vsix
```

Install in VS Code: `Extensions → ... → Install from VSIX`
