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
| `/open-terminal` | Open a named terminal in a given cwd (`cmd=` inline, or `cmdFile=` to run a command from a file) |
| `/close-terminal` | Close a named terminal (falls back to PID kill if registry desynced) |
| `/rename-terminal` | Rename / set status icon via `status=` (or `label=`, or `quiet=1`) |
| `/list` | Query tracked terminals (name, cwd, status, pid, live) |
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
