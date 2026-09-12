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

## `list` reports age and liveness, never a verdict (v0.18.0+)

Each row carries `createdAt`, `updatedAt`, `statusChangedAt`, `lastHeartbeatAt`, `pidAlive`, and `agentAlive` (house.health#4589), plus a top-level `now` to compute ages against.

`statusChangedAt` moves only when the status **value** changes — repeat `status=working` calls from hooks don't reset it, so "how long has this been working" stays answerable. `lastHeartbeatAt` moves on *every* `/rename-terminal` call including idempotent no-ops, and that's the point: status is self-reported, so a wedged agent and a busy one both say `working` forever. `working` with a 40-minute-old heartbeat is wedged.

Two things the bridge deliberately does not do: it never derives status from staleness (a build legitimately runs quiet for 20 minutes — pick your own threshold), and it never fabricates a timestamp for an entry that predates v0.18.0. `null` means unknown.

`pidAlive` tracks the terminal's **shell**, not the agent inside it. A crashed `claude` usually leaves a live shell prompt behind, so `pidAlive` stays true — it catches the tab-is-gone case, nothing more.

## `agentAlive` is the answer to the question every caller was reimplementing (house.health#4589)

A finished worker, a worker blocked on a real question, and a bare shell left behind by a crashed
agent all read `pidAlive: true` — that field only ever proved the shell was there, by design (see
above). house.health#4589 recorded a live incident: a session ended mid-turn with the tab reporting
`status=idle live=true pidAlive=true`, and `ps -p <pid> -o command` read `/bin/zsh -il` — which is
exactly what a *healthy* tab also reads, because the tracked pid is the shell either way. Two
orchestrator actions (`send`, `nudge`) were spent on the corpse before a human checked by hand. The
correct check was always `pgrep -P <pid>` for a live `claude` descendant, not the tracked pid's own
name — every caller doing this by hand was one `ps -p` typo away from the same false read.

`agentAlive` runs that check inside `/list` so nobody has to. It reports whether the tracked shell
has a live child process whose command matches `claude`. Same fail-closed contract as `pidAlive`:
`null` means unknown, never dead, and is the only thing an unresolved pid or a timed-out `pgrep`/`ps`
read (time-boxed at 250ms, same box as `pidAlive`) is allowed to report. A shell already confirmed
dead (`pidAlive: false`) reports `agentAlive: false` directly without spending a child-process read
on it — a dead shell cannot have a live child.

`agentAlive` does not prove the agent is *doing* anything — a wedged agent's process is still alive.
Pair it with `lastHeartbeatAt` for that, the same way `pidAlive` always needed to be.

## A Stop hook that refuses to let `idle` lie (house.health#4589)

Two 2026-09-09 sessions ended a turn `idle` with no note — the second one after an explicit
in-prompt instruction not to — and in both cases real findings were nearly lost. That is direct
evidence a prompt-level instruction does not hold under a long turn: it was tried twice, once
explicitly, and failed both times. The fix had to move out of the prompt and into the hook wiring,
which is the one thing that runs unconditionally on every `Stop`.

`bridge_hook_status` (in `bin/vscode-bridge.sh`, called by the same `Stop → hook-status idle` entry
this file has always scaffolded — no settings.json change needed) now tracks, locally and per
terminal, when the current turn actually started: the first transition into `working`/`subagent`
after anything else. When a `Stop` hook then asks for `idle`, that mark is compared against the
terminal's own `noteUpdatedAt` (fetched via `/note`, the same endpoint `note get` uses). A note that
predates the turn — or doesn't exist — means this turn's output was never handed off, and the status
actually written is `needs-input` instead of `idle`: the one status that asserts a human is required,
which is precisely true of a turn that ended without a handoff. A note newer than the mark proves the
turn spoke for itself, and `idle` is left alone.

This is an auto-promotion, not a block. A block (the Stop hook exiting non-zero to force the turn to
keep going) was considered and rejected: it bets the model responds correctly to being forced back
in, which is the same class of failure this fix exists to route around, and risks a loop with no
backstop. Auto-promoting to `needs-input` needs nothing from the model at all — it's a fact the
bridge asserts about what actually happened, the same way `agentAlive` above is a fact rather than a
request.

Fails open, not closed, matching this file's `hook-output` rule that a hook firing on every `Stop`
must never fail the turn: an unreadable local cache, an unreachable bridge, or any other read failure
falls through to the requested state unchanged. This only ever narrows `idle` to `needs-input` — it
never blocks, never errors, and never invents a note that wasn't written. The local turn-start cache
lives at `~/.vscode-terminal-bridge/turn-state/<name>`, one file per tracked terminal name.

## `needs-input` means a human is required — not "quiet for a minute"

Claude Code fires its `Notification` hook for two unrelated things: a real permission/input request,
and the "waiting for your input" nudge that arrives after ~60s of quiet. The hook command is a fixed
string (`hook-status needs-input`), so both landed as `needs-input` — the one status asserting a
human is required, and the one `send`/`nudge` refuse on. Any agent that finished its turn and sat
quiet therefore falsely claimed to need a human, and an orchestrator reading `list` could not tell a
blocked worktree from a finished one.

Observed 2026-09-04: five worktree terminals, all correctly stopped after being told to hold, all
reading `needs-input`; every subsequent `send` needed `--force` to get past a guard that should never
have been armed.

`bridge_hook_status` now disambiguates on the payload it already drains, so the `settings.json`
one-liner is unchanged and no reinstall is needed. The idle nudge is really end-of-turn, which is
exactly `idle` — what the `Stop` hook already writes. **Fail-safe by construction:** only the known
idle phrasings are downgraded, so an unrecognized or absent message still asserts `needs-input`, and
a real permission prompt is never silently demoted. `test/hook-status-notification.test.js` pins all
six cases.

Note this is the same failure shape as the `bg-task` collapse below — a single scalar carrying two
independent meanings — but the fix is different, because here the two meanings genuinely *are*
mutually exclusive turn states. Only the source was ambiguous, so disambiguating at the source is
enough; a new status value would have re-created the collapse.

## Background work is a second dimension, not a status (v0.21.0+)

`status` is last-writer-wins, and the states written into it aren't mutually exclusive. Turn state (`working`/`idle`/`needs-input`, from `PreToolUse`/`Notification`/`Stop`) and outstanding background work (`bg-task`, from `TaskCreated`) were sharing one field. An agent that started a background task and then ended its turn wrote `bg-task` and had it overwritten moments later — so the tab read `needs-input`, the one status asserting a human is required, for exactly the interval the work was in flight. An orchestrator reading `list` sent attention to a tab that needed nothing.

So the count lives in `pendingTasks` / `bgTask` / `bgTaskStartedAt`, written by `/bg-task?op=start|end|clear` and never by `status`. The both-at-once case — blocked on a human *while* a task runs — is now representable, which no single scalar can express.

`list` reports both dimensions raw plus `displayStatus`, the derived value the tab renders: prompt/error states first (a human being required outranks a machine being busy), then `bg-task` when anything is outstanding, then the raw turn state. That precedence is display-only; consumers can apply their own.

Existing wiring is routed rather than broken: `status=bg-task` on `/rename-terminal` counts up without touching turn state, and `status=task-done` counts down *when something is outstanding* — on a terminal with nothing pending it stays the manual completion badge it always was. Wire `start`/`end` as a pair; a start with no end leaves the count stuck, and the bridge won't guess (it reports `bgTaskStartedAt` and lets you pick a threshold).

## `close` removes the row, not just the tab (v0.19.0+)

`close` used to operate on the VS Code terminal object and treat "no such object" as nothing-to-do. A terminal whose process had already exited therefore left a registry row that no *targeted* verb could remove — `sweep` was the only escape, and `sweep` takes no target, so clearing one dead row meant risking every live worktree tab (#22). Rows accumulated permanently, and `list` — the orchestrator's only status query — accumulated permanent false entries.

Now `close` reconciles the row in every case and reports which one it hit: `outcome: closed` (disposed something live, or killed its pid), `row-removed` (process was already gone, bookkeeping cleaned up), `not-tracked` (404, no such row). Exit status from the CLI stays 0 for all three — cleanup paths call `close` under `set -e`, and "the terminal you asked to be gone is gone" is not a failure. Silence with no output still means the bridge was unreachable.

`forget <name>` is the registry-only verb: it drops the row and never signals a pid or disposes a terminal. Use it when you know the process is dead and only want the bookkeeping cleared; use `close` when you want the process gone too.

## `send` talks to a session that's already running (v0.17.0+)

`open`'s `cmd` only fires at spawn, so the only way to get a message into a live agent session used to be close + re-open — which restarts it and throws away its context. `send` delivers into the running session instead. Three things about it are load-bearing:

- **`--text-file` injects file *contents*.** It is not `open --cmd-file`, which turns into `bash <file>` — running a script is meaningless against a live TUI.
- **Multi-line payloads go over as one bracketed paste**, then a single submit. Otherwise every embedded `\n` acts as Enter and a three-paragraph message submits paragraph 1 as a truncated turn. `--mode=join` collapses newlines to one line if a target doesn't honour bracketed paste.
- **It refuses when the tracked status is `needs-input` or `permission`** (409), because text injected at a menu is read as an answer to that menu. `--force` overrides.

Exit 0 means *written to the terminal*, not *read and acted on* — `sendText` queues when the target is mid-execution.

Confirm pickup by comparing `lastSendAt` (stamped on a submitted send, v0.20.0+) — and read `lastSendDelivery` alongside it (v0.24.0+, below) — against `lastHeartbeatAt` in `list`: heartbeat older than send means delivered-but-not-picked-up, heartbeat newer means the agent has acted since your text landed. A status transition is not a substitute — hooks fire on tool calls, so an agent that reasons before acting still reads `needs-input` well after your text arrived, and a transition that does happen can't be attributed to your send. `send` deliberately does *not* flip status itself: that would assert a transition the bridge hasn't observed, and it breaks worst at a permission prompt, where injected text is consumed as an answer that may not unblock anything. Reading a terminal's output back is a separate, unsolved problem (issue #32).

## `submitted` was a claim the bridge couldn't back (v0.24.0+)

A multi-line send to a *busy* target frequently didn't submit: the TUI collapses a large paste into a `[Pasted text #N +M lines]` placeholder, registering it is asynchronous, and an Enter written in the same tick against a mid-turn agent is discarded rather than buffered. The message parks in the input box, where waiting never consumes it — and the response said `submitted: true` (#48). That's worse than the documented delivered≠read gap: an orchestrator polling `lastHeartbeatAt` sees a healthy working agent the entire time a message it considers sent will never be read.

Three changes, none of which pretend the bridge can see the terminal (VS Code exposes no read side):

- **The submit is separated from the paste in time** — `submitDelayMs`, default 250ms on the paste path, 0 elsewhere, overridable per call. This is the actual fix if the race theory holds.
- **`delivery` replaces the claim.** `submitted` (direct path — text and Enter back to back), `submit-unverified` (paste path — Enter written, consumption unobservable), `staged` (`submit=0`), `nudge`. The old `submitted` boolean stays for existing callers but only ever meant "an Enter was written".
- **`list` carries it** as `lastSendDelivery`. `submit-unverified` + a heartbeat older than `lastSendAt` is the stranded signature, and it's the first form in which "stranded" is distinguishable from "busy" in a single poll. The bridge reports the pair and calls neither, the same way it never derives status from staleness.

`nudge <name>` sends the bare Enter that releases it. Deliberately caller-driven: a blind second Enter on a target that *did* consume the first is an empty submit, which most TUIs ignore and none promise to — and re-sending the text instead would duplicate the message. Refused at `needs-input`/`permission` like `send`, because Enter at a menu picks the highlighted option. `--mode=join` avoids the placeholder path entirely, at the cost of one line.

## `note` is the worker's half of the loop (v0.22.0+)

`send` gets a message *into* a running session; a note is how that session reports back. It's the tractable subset of #32: most of what an orchestrator needs isn't the raw terminal buffer, it's *am I done, what did I ship, what needs deciding, what did I touch* — which requires only that the worker can publish it.

Three things are load-bearing:

- **`list` returns `noteUpdatedAt`, never the body.** An orchestrator polls `list` constantly; inlining bodies would make every triage pass proportional to how much everyone wrote. Fetch bodies from `note get` only for entries whose timestamp moved.
- **Notes go through the bridge, not a file on disk.** A worker may be on another machine with no shared filesystem. `bridgectl note set` inside a remote job posts to that machine's worker daemon (`/job-note`, using `WORKER_JOB_ID`/`WORKER_TOKEN` exported into the job), and `bridge-tail.sh` relays it home on the next `/job-status` poll — same command wherever the worker runs.
- **Over 4KB is truncated, not rejected**, on a character boundary, with `truncated: true` reported. A clipped handoff still carries the facts at its head; this is a summary, not a log.

A note is a **self-report**, with more authority than a status colour because it reads like a report. Write receipts, not prose — `shipped: pr=<n> branch=<b> sha=<sha>`, `touched: env=shared-dev mutations=1 row` — so the orchestrator can reconcile against git/PR state rather than relay a claim. The bridge deliberately does not validate note contents, the same way it never derives status from staleness.

## `output` is read-back without reading the terminal (v0.23.0+)

An orchestrator could send into a session and read its self-reported note, but not learn what the agent actually *said* — so anything conversational still needed a human to paste it back. VS Code has no stable API for reading a terminal buffer (`onDidWriteTerminalData` is proposed-only; shell integration models discrete commands, not a long-running TUI), so this reuses the hook rail instead.

`bridgectl hook-output`, wired on `Stop`/`SubagentStop`, reads **`last_assistant_message` out of the hook payload** and posts it. It deliberately does *not* tail `transcript_path`: the transcript lags the live conversation and parsing it would couple the bridge to Claude Code's on-disk format. The bridge stores an opaque string it never interprets.

Bounded by construction: a ring of the last 3 messages, 4KB each, keeping the **tail** (a message's conclusion is what an orchestrator is asking about — notes cap the other way, since receipts put facts first). `list` exposes `lastOutputAt`/`outputCount` only.

It degrades to silence, never an error: nothing published reads as an empty list, a quiet turn as `stored: false`, and a malformed payload / missing field / missing `node` as a no-op that still exits 0 — a hook on every Stop must never fail the turn. Two limits worth knowing: it captures only the turn's final text (not tool output or intermediate reasoning), and remote worker nodes aren't covered — a remote job publishes a `note` instead.

## `prUrl` is data plumbing, not a GitHub client (#50, v0.25.0+)

`bridgectl pr <name> <url>` stores a PR url against a tracked terminal; `list` reports it back as `prUrl` / `prSetAt`, `null` when unset. Idempotent by name, last write wins — the same `persistMetadata` merge every other field uses, so no special-case guard was needed.

That's the whole feature. The bridge does not poll GitHub, does not know a token, and does not assert the PR is still open — treat the value as advisory: it may have been merged, closed, or force-pushed since it was set. Whoever needs the PR's actual current state polls it themselves, outside the bridge, the same way background-job status and note bodies are left to the caller.

## Env var names: expand/contract off `HH_` (#57, v0.27.0+)

Every terminal `/open-terminal` spawns gets `VSCODE_BRIDGE_ORCHESTRATOR_ID` and `VSCODE_BRIDGE_STATUS_URL` exported into it now, matching the `VSCODE_BRIDGE_PORT` prefix the extension already used. They used to be `HH_ORCHESTRATOR_ID` / `HH_BRIDGE_STATUS_URL` — named after `house.health`, one private consumer, even though every hook and script that talks to the bridge reads them. That's a naming leak in a general-purpose extension's public contract, not a behavior change, which is why this is expand/contract rather than a rename in place: **this release exports both old and new names side by side.** Nothing that reads either name breaks.

The `HH_` names are deprecated and will be **dropped in v0.28.0**. Known callers on the old names — `agent-workflows` (`bin/wt-setup`, `bin/wt-finish`, `bin/pre-pr-gate`) and `house.health` (hooks, `scripts/`, `.claude/`) — are migrated to read the new names (preferring them, falling back to the old) in the same pass as this release, in their own repos' commits.

## `.sdo/` is a setting now, not a hardcoded path (#57, v0.27.0+)

`/api/status` used to always append `pipeline-state.json` under a hardcoded `.sdo/` directory in the matched workspace folder — `.sdo` is a private consumer's directory name, not something a general extension should assume. It's now `terminalBridge.pipelineStateDir`, a VS Code setting defaulting to `.sdo` so nothing changes on disk for anyone until they opt in. Set it per-workspace in `.vscode/settings.json` to write somewhere else.

## Public-surface audit (#57)

Full audit for consumer-specific naming, ahead of first publication:

- **Fixed this pass:** `HH_ORCHESTRATOR_ID` / `HH_BRIDGE_STATUS_URL` env vars, `.sdo/` output directory (above); `package.json`'s `description` referenced `/worktree-start`, a private consumer's slash command, and has been reworded to describe what the extension does instead of who calls it.
- **Found, left alone — a bigger call than a naming pass:** the extension identity itself, `publisher: "sdo"` / `displayName: "SDO Terminal Bridge"` in `package.json`. Changing either changes the extension ID (`sdo.terminal-bridge`) that the README's install instructions, `bin/vscode-bridge.sh`, and `bin/bridgectl.sh` all reference by name, and is a republishing/reinstall event for every existing install, not a text edit. Worth a decision with eyes on it, not a drive-by rename.
- **Found, left alone — informational, not part of the interface:** `house.health#4589` citations in `CLAUDE.md`, `extension.js` comments, and `test/agent-alive.test.js` / `test/idle-note-guard.test.js`. These document *why* a behavior exists (a real incident in a real private tracker) rather than anything a caller depends on — no HTTP route, CLI flag, or file path is named after that repo. Scrubbing them would lose the provenance for no interface benefit.
- **Checked and clean:** HTTP routes and payload fields, CLI subcommands/flags in `bin/*.sh`, file and directory names under `~/.vscode-terminal-bridge/` (`port`, `nodes.json`, `bin/`), and log/error strings — none of these are named after a specific consumer.

## Key endpoints

All endpoints are GET with query-string params (not POST/JSON — see `extension.js`).

| Endpoint | Purpose |
|----------|---------|
| `/open-terminal` | Open a named terminal in a given cwd (`cmd=` inline, or `cmdFile=` to run a command from a file) |
| `/close-terminal` | Close a named terminal (falls back to PID kill if registry desynced; always reconciles the registry row) |
| `/forget-terminal` | Drop a tracked registry row without touching any process |
| `/rename-terminal` | Rename / set status icon via `status=` (or `label=`, or `quiet=1`) |
| `/list` | Query tracked terminals (name, cwd, status, pid, live, timestamps, background work) |
| `/bg-task` | Report outstanding background work (`op=start|end|clear`) — a dimension of its own, not a status |
| `/send-text` | Inject text into an already-running tracked terminal (`text=` or `textFile=`); a headless worker (`bridgectl worker`, `mode:"headless"` on `/list`) gets it in its inbox instead (`delivery:"inbox"`) |
| `/nudge-terminal` | Bare Enter — releases a paste left staged in the target's input box (refused on a headless worker) |
| `/heartbeat` | Stamp `lastHeartbeatAt` and nothing else — a headless worker calls it from its agent's event stream |
| `/worker-permission` | A headless worker's escalated permission prompt: read it (no `behavior=`), or answer with `behavior=allow` or `behavior=deny` |
| `/set-note` · `/note` · `/clear-note` | A worker's short handoff for its orchestrator (`text=` / `textFile=`) |
| `/set-output` · `/output` · `/clear-output` | Read-back: the turn's final assistant text, pushed in by a Stop hook |
| `/set-pr` | Record a PR url on a tracked terminal (`name=`, `url=`) — advisory, last write wins |
| `/sweep` | Dispose terminals whose cwd no longer maps to a live `git worktree` |
| `/add-folder` / `/remove-folder` | Attach/detach a workspace folder |
| `/reindex` | Re-link open terminals to persisted metadata |
| `/ping` | Health check — returns port, pid, workspace folders |

## Calling it — use the bundled CLI, not raw curl

Don't hand-roll curl calls. The extension bundles `bin/vscode-bridge.sh` + `bin/bridgectl.sh` and writes them to `~/.vscode-terminal-bridge/bin/` on every activation, so the calling convention (port discovery, GET param shapes, status-map values) stays in sync with whatever extension version is installed:

```bash
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open <name> <cwd> [cmd] [icon] [color]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh status <name> <state>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh send <name> <text>|--text-file=<path> [--submit-delay=<ms>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh nudge <name> [--force]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh close <name>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh forget <name>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh note set <text>|--text-file=<path> [--name=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh note get <name>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh output <name> [--n=<1..3>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh bg-task {start|end|clear} [--name=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh pr <name> <url>
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh hook-status <status> [--name=<name>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend {cline|claude} [--dir=<repo>]
bash ~/.vscode-terminal-bridge/bin/bridgectl.sh scaffold --backend claude --apply [--settings=<path>]
```

Source of these scripts is `bin/` in this repo — edit there, not the installed copy under `~/.vscode-terminal-bridge/`.

## Scaffolding Claude hooks: `--apply` merges, printing documents (v0.24.0+)

`scaffold --backend claude` prints the target state; `--apply` computes the delta and merges it into `settings.json` (default `~/.claude/settings.json`, `--settings=` for a project one). Upgrading a real install came down to one missing `Stop` entry, found by hand-reading a file whose existing hooks were pre-v0.13 inline curl — mechanical work, and every step a chance to clobber something working (#47).

Additive per event (an existing group keeps its hooks; ours is appended as its own group, never inheriting a `matcher` we don't understand), idempotent on the exact command string, reporting added/already-present per event, backing up to `<settings>.bak`, and **refusing outright on malformed JSON** — a `settings.json` that doesn't parse disables every setting in it, so a partial write is worse than no write. Both paths render from one spec (`_bridge_claude_hook_spec`) so they can't drift.

## Status icons (for rename-terminal `status=` param)

| Status | Icon | Color |
|--------|------|-------|
| `working` | spinning loader | cyan |
| `idle` | pause | green |
| `error` | error | red |
| `needs-input` | bell | yellow |
| `subagent` | array symbol | magenta |
| `task-done` | checkmark | green |
| `bg-task` | server process | blue |

`bg-task` and `task-done` are routed to the background-work dimension when sent as `status=` — see above.

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
