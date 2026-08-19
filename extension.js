const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

let server;

// ---------------------------------------------------------------------------
// Bundled CLI distribution — write the version-matched bin/*.sh scripts to a
// fixed, repo-independent path on every activation so consuming repos call
// one canonical copy instead of vendoring their own. Bumping the extension
// version re-syncs every repo automatically; no per-repo copy-paste.
// ---------------------------------------------------------------------------

const CLI_INSTALL_DIR = path.join(require('os').homedir(), '.vscode-terminal-bridge', 'bin');

// User-level port file — the cwd-independent discovery path for callers that
// can't find a workspace `.vscode-bridge-port` by walking up from $PWD.
const PORT_FALLBACK_DIR = path.join(require('os').homedir(), '.vscode-terminal-bridge');
const PORT_FALLBACK_PATH = path.join(PORT_FALLBACK_DIR, 'port');

function writeBundledCli(context) {
  try {
    fs.mkdirSync(CLI_INSTALL_DIR, { recursive: true });
    for (const name of ['vscode-bridge.sh', 'bridgectl.sh', 'bridge-tail.sh']) {
      const src = path.join(context.extensionPath, 'bin', name);
      const dest = path.join(CLI_INSTALL_DIR, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
  } catch (err) {
    console.error('[terminal-bridge] failed to write bundled CLI:', err.message);
  }
}

// POSIX single-quote a string for safe use as one shell argument.
function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

// Stable registry: creation key → terminal instance.
// Survives display name changes within a session.
const terminals = new Map();

// workspaceState key for persisted terminal metadata.
const METADATA_KEY = 'terminalBridgeMetadata';

// ---------------------------------------------------------------------------
// Canonical lifecycle status → codicon + color mapping.
// Lives here so every caller (hooks, skills, ad-hoc curls) gets a consistent
// look without copy-pasting the mapping.
// ---------------------------------------------------------------------------

const STATUS_MAP = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  'working':     { codicon: 'loading~spin',   color: 'terminal.ansiCyan' },
  'needs-input': { codicon: 'bell-dot',       color: 'terminal.ansiYellow' },
  'idle':        { codicon: 'debug-pause',    color: 'terminal.ansiGreen' },
  // ── Blocking / error states ────────────────────────────────────────────────
  'permission':  { codicon: 'shield',         color: 'terminal.ansiBlue' },
  'error':       { codicon: 'error',          color: 'terminal.ansiRed' },
  // ── Background / parallel work ─────────────────────────────────────────────
  'compacting':  { codicon: 'archive',        color: 'terminal.ansiBlue' },
  'subagent':    { codicon: 'symbol-array',   color: 'terminal.ansiMagenta' },
  'bg-task':     { codicon: 'server-process', color: 'terminal.ansiBlue' },
  'task-done':   { codicon: 'check-all',      color: 'terminal.ansiGreen' },
  // ── Completion badges ──────────────────────────────────────────────────────
  'pr-open':     { codicon: 'pass-filled',    color: 'terminal.ansiGreen' },
  'merged':      { codicon: 'git-merge',      color: 'terminal.ansiMagenta' },
};

// ---------------------------------------------------------------------------
// Metadata helpers — keep workspaceState in sync with the in-memory map.
// Stored shape: { [name]: { cwd?, label?, baseLabel?, status?, color?, effectiveLabel? } }
//   label         — full display label (the effective label with codicon prefix if any)
//   baseLabel     — the clean base label without a status codicon prefix
//   status        — last known status= value (null if none)
//   effectiveLabel — what was last passed to renameWithArg (for idempotency checks)
// ---------------------------------------------------------------------------

function loadMetadata(context) {
  return context.workspaceState.get(METADATA_KEY) || {};
}

// Every metadata write is stamped here rather than at the call sites, so a new
// caller can't forget to and quietly produce an entry with no age.
//
// The distinction that matters: `updatedAt` moves on any write, but
// `statusChangedAt` moves only when the status VALUE changes. A PreToolUse
// hook firing `status=working` every few seconds must not keep resetting it,
// or "how long has this been working" — the question the field exists to
// answer — becomes unanswerable.
//
// `createdAt` is set only when the entry is genuinely new. An entry persisted
// before v0.18.0 keeps a null createdAt forever instead of being stamped with
// the time of its next write, which would be a fabrication: the terminal was
// created earlier, and "unknown" is the honest answer.
async function persistMetadata(context, name, update) {
  const meta = loadMetadata(context);
  if (update === null) {
    delete meta[name];
  } else {
    const prev  = meta[name];
    const isNew = prev === undefined;
    const now   = new Date().toISOString();
    const next  = { ...prev, ...update, updatedAt: now };

    if (isNew) next.createdAt = now;

    if ('status' in update && update.status !== (prev?.status ?? null)) {
      next.statusChangedAt = now;
    }

    meta[name] = next;
  }
  await context.workspaceState.update(METADATA_KEY, meta);
}

// Record that we heard from the agent inside this terminal, independent of
// whether anything about its state changed.
//
// `status` is self-reported: it says what the agent last announced, not what's
// true now. A subagent spinning on no-op calls and a subagent making progress
// both report `working` forever, and there's no way to tell them apart from
// the outside. `live` doesn't help — it only asserts the VS Code terminal
// object exists, which stays true around a crashed or hung process.
//
// So this stamps on EVERY /rename-terminal call, including the idempotent
// no-ops that the hook plumbing generates during sustained work. Those repeat
// calls are precisely the liveness signal: a `working` terminal whose last
// heartbeat is 40 minutes old is wedged, not busy. Only the caller can say
// where that threshold sits, so the bridge reports the timestamp and never
// derives status from it — a build legitimately runs quiet for 20 minutes.
async function touchHeartbeat(context, name) {
  const meta = loadMetadata(context);
  if (!meta[name]) return;  // never conjure an entry for an untracked name
  meta[name] = { ...meta[name], lastHeartbeatAt: new Date().toISOString() };
  await context.workspaceState.update(METADATA_KEY, meta);
}

// Record that we injected text into this terminal (issue #39).
//
// /send-text's exit status says the text was WRITTEN, not that the agent read
// it — sendText queues in the terminal buffer, so a success is a delivery
// receipt, not an acknowledgment. The docs used to suggest confirming pickup
// by watching for a status transition, which doesn't survive contact: hooks
// fire on tool calls, so an agent that reasons before acting still reads
// `needs-input` well after your text landed, and a transition that does happen
// can't be attributed to your send rather than to the agent acting on its own.
//
// A timestamp makes acknowledgment a comparison the CALLER makes:
//
//   lastHeartbeatAt < lastSendAt   delivered, not yet picked up
//   lastHeartbeatAt > lastSendAt   picked up — the agent has acted since
//   lastSendAt === null            nothing was ever sent
//
// Deliberately NOT a status mutation. Optimistically flipping needs-input to
// working on send would be the bridge asserting a transition it hasn't
// observed, and it breaks exactly where it matters most: text injected at a
// permission dialog is consumed as an answer to that dialog, and if the answer
// doesn't unblock the agent the terminal is still waiting while the registry
// claims otherwise. Facts, not verdicts.
async function touchLastSend(context, name) {
  const meta = loadMetadata(context);
  if (!meta[name]) return null;  // never conjure an entry for an untracked name
  const now = new Date().toISOString();
  meta[name] = { ...meta[name], lastSendAt: now };
  await context.workspaceState.update(METADATA_KEY, meta);
  return now;
}

// Is the tracked process still there? `process.kill(pid, 0)` sends no signal —
// it just tests for existence (and our permission to signal it).
//
// Read this for what it is: the pid is the terminal's SHELL, not the agent
// running inside it. A crashed `claude` usually drops back to a live shell
// prompt, so pidAlive stays true — which is the whole reason lastHeartbeatAt
// exists. It's a cheap fact that catches the tab-is-gone case, not a
// process-supervision answer.
function isPidAlive(pid) {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Remote node registry — laptop-side config for offloading jobs to workers
// (bin/worker.js, running headless on e.g. a Mac Mini). Lives outside any
// workspace folder since it's a per-machine, not per-repo, credential store.
// ---------------------------------------------------------------------------

const NODES_REGISTRY_PATH = path.join(require('os').homedir(), '.vscode-terminal-bridge', 'nodes.json');

function loadNodeRegistry() {
  try {
    return JSON.parse(fs.readFileSync(NODES_REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function postJson(host, port, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host, port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
    }, res => {
      let resBody = '';
      res.on('data', chunk => { resBody += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(resBody) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(host, port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: urlPath, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Reattach proxy tabs for remote jobs still running on a worker node after a
// window reload — the remote analog of reindexTerminals()/sweepTerminals()
// above, since a remote job's ground truth lives on the worker, not in
// vscode.window.terminals.
// ---------------------------------------------------------------------------

async function reattachRemoteJobs(context) {
  const metadata = loadMetadata(context);
  const registry = loadNodeRegistry();
  let reattached = 0;

  for (const [name, meta] of Object.entries(metadata)) {
    if (!meta.node || !meta.jobId) continue;
    if (terminals.has(name)) continue; // already tracked this session

    const nodeCfg = registry[meta.node];
    if (!nodeCfg) continue; // node no longer configured — nothing we can do

    let stillRunning;
    try {
      const { json } = await getJson(
        nodeCfg.host, nodeCfg.port,
        `/job-status?id=${encodeURIComponent(meta.jobId)}&offset=0`,
        nodeCfg.token
      );
      stillRunning = !!(json && !json.done);
    } catch {
      // Worker unreachable right now — don't assume it's done; recreate the
      // tab so bridge-tail.sh's own polling can resolve the real state once
      // the worker is reachable again.
      stillRunning = true;
    }

    if (!stillRunning) {
      await persistMetadata(context, name, null);
      continue;
    }

    const options = { name };
    if (meta.color) options.color = new vscode.ThemeColor(meta.color);
    const terminal = vscode.window.createTerminal(options);
    terminal.show(true);
    terminal.sendText(`bash ${CLI_INSTALL_DIR}/bridge-tail.sh ${meta.node} ${meta.jobId}`);
    terminals.set(name, terminal);
    reattached++;
  }

  if (reattached > 0) {
    console.log(`[terminal-bridge] reattached ${reattached} remote job(s)`);
  }
  return reattached;
}

// ---------------------------------------------------------------------------
// Git worktree discovery
// ---------------------------------------------------------------------------

function normalizePath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

async function parseWorktrees() {
  // Returns Map<absolutePath, name> where name is the last path segment.
  // e.g. '/Users/…/worktrees/vscode-terminal-bridge/issue-11' → 'issue-11'
  // Resolved relative to the first workspace folder, since the extension
  // host's process.cwd() isn't guaranteed to be inside any repo at all.
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return new Map();
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd });
    const worktrees = new Map();
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const p = normalizePath(line.slice(9).trim());
        worktrees.set(p, p.split('/').pop());
      }
    }
    return worktrees;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Notes: let a worker publish a short handoff its orchestrator can read.
//
// The tractable subset of "read a terminal's output" (#32): most of what an
// orchestrator needs from a worker isn't the raw buffer, it's a handful of
// facts — am I done, what did I ship, what needs deciding, what did I touch.
// That doesn't require reading output at all, only the worker being able to
// publish it.
//
// Stored server-side in the registry next to `status`, never on the caller's
// disk, for the same reason `status` works that way: a worker may be running
// on another machine, where there is no shared filesystem with the
// orchestrating session.
//
// The bridge does NOT validate note contents — same principle as never
// deriving status from staleness. A note is a self-report, and one that reads
// like a report carries more authority than a status colour does; the README
// recommends a receipts format (pointers the orchestrator can independently
// check) rather than the bridge trying to police prose.
const MAX_NOTE_BYTES = 4096;

async function setNote(context, name, text) {
  const meta = loadMetadata(context);
  if (!meta[name]) return null;  // never conjure an entry for an untracked name

  // Truncate rather than reject: a handoff arriving clipped still carries the
  // state/shipped lines at its head, where the recommended format puts the
  // facts. Rejecting would lose the whole thing over a detail at the end.
  // Cut on a character boundary so the stored note stays valid UTF-8.
  const raw = String(text ?? '');
  let body = raw;
  let truncated = false;
  if (Buffer.byteLength(raw, 'utf8') > MAX_NOTE_BYTES) {
    const buf = Buffer.from(raw, 'utf8').subarray(0, MAX_NOTE_BYTES);
    body = buf.toString('utf8').replace(/\uFFFD$/, '');
    truncated = true;
  }

  const now = new Date().toISOString();
  meta[name] = {
    ...meta[name],
    note: body,
    noteUpdatedAt: now,
    noteTruncated: truncated,
    noteBytes: Buffer.byteLength(body, 'utf8'),
  };
  await context.workspaceState.update(METADATA_KEY, meta);
  return { noteUpdatedAt: now, truncated, bytes: meta[name].noteBytes };
}

async function clearNote(context, name) {
  const meta = loadMetadata(context);
  if (!meta[name]) return null;
  meta[name] = {
    ...meta[name],
    note: null, noteUpdatedAt: null, noteTruncated: false, noteBytes: 0,
  };
  await context.workspaceState.update(METADATA_KEY, meta);
  return { cleared: true };
}

// ---------------------------------------------------------------------------
// Background work is a SECOND dimension, not a status value (issue #40).
//
// `status` is a last-writer-wins scalar, but the things written into it aren't
// mutually exclusive. At least two independent dimensions were sharing it:
//
//   turn state           working / idle / needs-input   (PreToolUse, Notification, Stop)
//   outstanding bg work  bg-task / subagent             (TaskCreated, SubagentStart)
//
// An agent that starts a background task and then ends its turn writes
// `bg-task`, and `Notification`/`Stop` immediately overwrites it. Both writes
// are correct about their own dimension; collapsing them means the later one
// silently erases the earlier, and the tab reads `needs-input` — the one
// status that asserts a human is required — for exactly the interval the work
// is actually in flight.
//
// So the count lives in its own field. No precedence rules to get wrong, and
// the both-at-once case (genuinely blocked on a human WHILE a task runs) is
// representable, which no single scalar can express.
async function setBgTask(context, name, op) {
  const meta = loadMetadata(context);
  if (!meta[name]) return null;  // never conjure an entry for an untracked name

  const prev = Math.max(0, Number(meta[name].pendingTasks) || 0);
  let next;
  if (op === 'start')      next = prev + 1;
  else if (op === 'end')   next = Math.max(0, prev - 1);
  else if (op === 'clear') next = 0;
  else return null;

  const now = new Date().toISOString();
  const entry = { ...meta[name], pendingTasks: next };

  // bgTaskStartedAt marks when this terminal went from "nothing outstanding"
  // to "something outstanding" — the age a caller wants is the age of the
  // work, not of the most recent increment. Cleared when the count returns
  // to zero so a stale start time can't outlive the work it described.
  if (next > 0 && prev === 0) entry.bgTaskStartedAt = now;
  if (next === 0)             entry.bgTaskStartedAt = null;
  if (next !== prev)          entry.bgTaskChangedAt = now;

  meta[name] = entry;
  await context.workspaceState.update(METADATA_KEY, meta);
  return { pendingTasks: next, previous: prev, bgTaskStartedAt: entry.bgTaskStartedAt ?? null };
}

// Which STATUS_MAP key the tab should *render*. The data stays orthogonal —
// this is a display decision only, and /list reports both dimensions raw.
//
// A human being required outranks a machine being busy, so prompt and error
// states keep the tab. Below that, outstanding background work outranks the
// turn state, because "idle" on a terminal with a job in flight is the reading
// that sent an orchestrator to a tab that needed nothing.
const DISPLAY_PRIORITY_STATES = new Set(['needs-input', 'permission', 'error']);

function displayStatusKey(meta = {}) {
  const status = meta.status ?? null;
  if (status && DISPLAY_PRIORITY_STATES.has(status)) return status;
  if ((Number(meta.pendingTasks) || 0) > 0) return 'bg-task';
  return status;
}

// Apply the tab's presentation (label prefix + color) from whatever the
// registry currently says. Shared by /rename-terminal and /bg-task so both
// dimensions render through one code path instead of two that drift.
async function applyPresentation(context, name, terminal, opts = {}) {
  const { baseLabelOverride, explicitColor, iconId, explicitLabel } = opts;
  const meta     = loadMetadata(context)[name] ?? {};
  const key      = displayStatusKey(meta);
  const cfg      = (key && key !== 'none') ? (STATUS_MAP[key] ?? null) : null;

  const baseLabel = explicitLabel
    ?? baseLabelOverride
    ?? meta.baseLabel
    ?? meta.label
    ?? name;

  const effectiveLabel = explicitLabel
    ? explicitLabel                                   // legacy label= mode: caller owns the whole string
    : (cfg ? `$(${cfg.codicon}) ${baseLabel}` : baseLabel);

  const resolvedColor = explicitColor ?? cfg?.color ?? undefined;

  const labelChanged = effectiveLabel !== meta.effectiveLabel;
  const colorChanged = resolvedColor  !== meta.color;

  if (!labelChanged && !colorChanged && !iconId) {
    return { effectiveLabel, baseLabel, color: resolvedColor, displayStatus: key, noOp: true };
  }

  if (labelChanged) {
    // Only switch the active terminal if needed, and use show(true)
    // (preserveFocus) so keyboard focus is NEVER stolen.
    const prev = vscode.window.activeTerminal;
    const needsSwitch = prev !== terminal;
    if (needsSwitch) terminal.show(true);
    await vscode.commands.executeCommand(
      'workbench.action.terminal.renameWithArg',
      { name: effectiveLabel }
    );
    if (needsSwitch && prev) prev.show(true);
  }

  if (iconId)        terminal.iconPath = new vscode.ThemeIcon(iconId);
  if (resolvedColor) terminal.color    = new vscode.ThemeColor(resolvedColor);

  await persistMetadata(context, name, {
    label: effectiveLabel,
    baseLabel,
    effectiveLabel,
    color: resolvedColor,
  });

  return { effectiveLabel, baseLabel, color: resolvedColor, displayStatus: key, noOp: false };
}

// ---------------------------------------------------------------------------
// Re-index: match open VS Code terminals back into the `terminals` Map.
// ---------------------------------------------------------------------------

async function reindexTerminals(context) {
  const metadata  = loadMetadata(context);       // name → { cwd, label, color, … }
  const worktrees = await parseWorktrees();       // path → name

  // Build reverse map: cwd → name (from persisted metadata — takes precedence)
  const cwdToName = Object.fromEntries(
    Object.entries(metadata)
      .filter(([, m]) => m.cwd)
      .map(([name, m]) => [m.cwd, name])
  );

  let reindexed = 0;

  for (const terminal of vscode.window.terminals) {
    // Skip terminals already tracked in this session.
    if ([...terminals.values()].includes(terminal)) continue;

    let matched = false;

    // Strategy A — terminal.name matches a persisted key directly.
    // (VS Code preserves creation names across reloads for non-renamed terminals.)
    if (metadata[terminal.name]) {
      terminals.set(terminal.name, terminal);
      matched = true;
    }

    // Strategy B — shell-integration CWD lookup.
    if (!matched) {
      const cwd = terminal.shellIntegration?.cwd?.fsPath;
      if (cwd) {
        // Persisted metadata first (most precise), then git worktree basename.
        const name = cwdToName[cwd] ?? worktrees.get(normalizePath(cwd));
        if (name) {
          terminals.set(name, terminal);
          matched = true;
        }
      }
    }

    if (matched) {
      reindexed++;
      // Restore color from persisted metadata (simple property assignment,
      // no terminal-activation required).
      const name = [...terminals.entries()].find(([, t]) => t === terminal)?.[0];
      const savedColor = name && metadata[name]?.color;
      if (savedColor) {
        try { terminal.color = new vscode.ThemeColor(savedColor); } catch { /* noop */ }
      }
    }
  }

  if (reindexed > 0) {
    console.log(`[terminal-bridge] re-indexed ${reindexed} terminal(s)`);
  }
  return reindexed;
}

// ---------------------------------------------------------------------------
// Sweep: dispose terminals whose persisted cwd no longer maps to a live
// worktree (ground truth = `git worktree list`), falling back to a PID kill
// when the VS Code terminal object itself can't be found (registry desync).
// ---------------------------------------------------------------------------

async function sweepTerminals(context) {
  const worktrees = await parseWorktrees();   // path → name
  const metadata  = loadMetadata(context);
  const closed = [];

  // Fail closed: an empty worktree map almost always means we couldn't
  // determine ground truth (no workspace folder, git not found, etc.),
  // not that zero worktrees exist. Sweeping on that basis would dispose
  // every tracked terminal, including live ones (see issue #22).
  if (worktrees.size === 0) {
    console.log('[terminal-bridge] sweep skipped: could not determine live worktrees');
    return closed;
  }

  for (const [name, meta] of Object.entries(metadata)) {
    if (!meta.cwd || worktrees.has(normalizePath(meta.cwd))) continue;

    const terminal = terminals.get(name) ?? vscode.window.terminals.find(t => t.name === name);
    if (terminal) {
      terminal.dispose();
    } else if (meta.pid) {
      try { process.kill(meta.pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    terminals.delete(name);
    await persistMetadata(context, name, null);
    closed.push(name);
  }

  if (closed.length > 0) {
    console.log(`[terminal-bridge] swept ${closed.length} stale terminal(s): ${closed.join(', ')}`);
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Close a terminal by name, falling back to a live-window name search and
// then a PID kill when the in-memory registry has desynced from reality.
//
// close is idempotent on the REGISTRY, not just on the terminal object
// (issue #41). The caller named a specific terminal and asked for it to be
// gone; if the VS Code object and the process have both already vanished, the
// registry row is the only part still observable, and leaving it behind means
// the row can never be removed by any targeted verb — `sweep` was the sole
// escape, and sweep takes no target (issue #22).
//
// So a missing terminal object is not "nothing to do", it's "reconcile". The
// outcome says which case we hit, because they mean different things to a
// caller: `closed` disposed something live, `row-removed` cleaned up after
// something that was already gone, `not-tracked` means there was never a row.
async function closeTerminalByName(context, name) {
  let terminal = terminals.get(name);
  if (!terminal) {
    await reindexTerminals(context);
    terminal = terminals.get(name) ?? vscode.window.terminals.find(t => t.name === name);
  }

  if (terminal) {
    terminal.dispose();
    terminals.delete(name);
    await persistMetadata(context, name, null);
    return { outcome: 'closed', method: 'dispose' };
  }

  // No live terminal object. Anything left is registry state — reconcile it.
  const meta = loadMetadata(context)[name];
  if (!meta) {
    terminals.delete(name);
    return { outcome: 'not-tracked', method: null };
  }

  // Fall back to killing by persisted PID when we still have one. A failure
  // here means the process is already dead, which is the same end state we
  // were asked for — so it drops through to the row removal below rather than
  // aborting.
  let method = 'registry';
  if (meta.pid) {
    try {
      process.kill(meta.pid, 'SIGTERM');
      method = 'pid-kill';
    } catch { /* already dead */ }
  }

  terminals.delete(name);
  await persistMetadata(context, name, null);
  return {
    outcome: method === 'pid-kill' ? 'closed' : 'row-removed',
    method,
  };
}

// ---------------------------------------------------------------------------
// Forget: drop a registry row and nothing else.
//
// The companion to close for the case where you know the process is gone and
// only want the bookkeeping cleared — never signals a PID, never disposes a
// terminal object. Safe to hand to an orchestrator in a way `sweep` is not,
// because it takes a target.
// ---------------------------------------------------------------------------

async function forgetTerminal(context, name) {
  const meta = loadMetadata(context)[name];
  const wasLive = terminals.has(name) || vscode.window.terminals.some(t => t.name === name);
  terminals.delete(name);
  if (!meta) return { outcome: 'not-tracked', wasLive };
  await persistMetadata(context, name, null);
  return { outcome: 'row-removed', wasLive };
}

// ---------------------------------------------------------------------------
// Send: inject text into a running tracked terminal.
//
// The counterpart to /open-terminal's startup `cmd`, for a session that's
// already running: deliver a message to the agent at its prompt without a
// close+reopen (which restarts the session and loses its context).
//
// Two things make this more than a bare sendText() call:
//
//   1. Newlines. sendText writes text as though typed, so in a TUI every
//      embedded \n acts as Enter — a three-paragraph message would submit
//      paragraph 1 as a complete turn and the rest as separate ones. We wrap
//      multi-line payloads in bracketed paste (ESC[200~ … ESC[201~) so the
//      receiving app takes them as one paste, then submit once. This is the
//      same mechanism that makes pasting multi-line text by hand work today.
//      Single-line payloads skip the wrapper entirely — nothing to protect
//      against, and no escape sequences to leak if the target doesn't honour
//      bracketed paste.
//
//   2. Prompt state. Text injected while the target is showing a permission
//      dialog or a numbered question is consumed as an answer to that menu,
//      not read as a message. We refuse when the last known status says the
//      terminal is waiting on input, unless force=1.
// ---------------------------------------------------------------------------

// Statuses where injected text would be eaten by an interactive prompt rather
// than read as a message. Refused without force=1.
const PROMPT_STATES = new Set(['needs-input', 'permission']);

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

async function sendTextToTerminal(context, name, text, opts = {}) {
  const { submit = true, force = false, mode = 'auto' } = opts;

  let terminal = terminals.get(name);
  if (!terminal || !vscode.window.terminals.includes(terminal)) {
    await reindexTerminals(context);
    terminal = terminals.get(name) ?? vscode.window.terminals.find(t => t.name === name);
  }
  // A terminal object that VS Code no longer lists has been disposed — the
  // registry is stale, and sending into it would silently go nowhere.
  if (!terminal || !vscode.window.terminals.includes(terminal)) {
    return { ok: false, code: 404, error: 'Terminal not found or not live', name };
  }

  const status = loadMetadata(context)[name]?.status ?? null;
  if (!force && PROMPT_STATES.has(status)) {
    return {
      ok: false, code: 409, name, status,
      error: `Terminal is at an interactive prompt (status=${status}); text would be read as an answer to it. Re-send with force=1 if that's intended.`,
    };
  }

  // Trailing newlines in the payload (every text file has one) would submit
  // before we do, so strip them and let `submit` be the only thing that sends.
  const payload = text.replace(/\n+$/, '');
  const multiline = payload.includes('\n');
  const usePaste = mode === 'paste' || (mode === 'auto' && multiline);

  let delivered;
  if (mode === 'join') {
    delivered = payload.replace(/\s*\n\s*/g, ' ');
    terminal.sendText(delivered, false);
  } else if (usePaste) {
    delivered = payload;
    terminal.sendText(PASTE_START + payload + PASTE_END, false);
  } else {
    delivered = payload;
    terminal.sendText(payload, false);
  }

  // Submit as a separate write so the newline lands outside the paste bracket —
  // inside it, it's just pasted content and never submits.
  if (submit) terminal.sendText('', true);

  // Stamp only on an actual submit. Staged-but-unsent text (submit=0) hasn't
  // been delivered to the agent, so recording it as a send would manufacture
  // the exact false positive lastSendAt exists to remove — a caller would
  // compare a heartbeat against a send that never happened.
  const lastSendAt = submit ? await touchLastSend(context, name) : null;

  return {
    ok: true, name, status, submitted: submit,
    mode: mode === 'join' ? 'join' : (usePaste ? 'paste' : 'literal'),
    bytes: Buffer.byteLength(delivered, 'utf8'),
    lastSendAt,
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

function activate(context) {
  // ── Sync the bundled CLI scripts to a fixed, version-matched path so every ──
  // ── consuming repo calls one canonical copy instead of vendoring its own. ───
  writeBundledCli(context);

  // ── Keep registry clean when the user closes a terminal manually ──────────
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(async closed => {
      for (const [key, t] of terminals) {
        if (t === closed) {
          terminals.delete(key);
          await persistMetadata(context, key, null);
          break;
        }
      }
    })
  );

  // ── Re-index on window focus (catches reload → user clicks back) ──────────
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) reindexTerminals(context);
    })
  );

  // ── Re-index when shell integration activates (VS Code 1.93+) ────────────
  if (typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
    context.subscriptions.push(
      vscode.window.onDidChangeTerminalShellIntegration(() => reindexTerminals(context))
    );
  }

  // ── Attempt re-index immediately (name-based matches) and after a short ──
  // ── delay so shell integration has time to become available. ─────────────
  reindexTerminals(context);
  const deferred = setTimeout(() => reindexTerminals(context), 2000);
  context.subscriptions.push({ dispose: () => clearTimeout(deferred) });

  // ── Sweep stale terminals left over from a crash/restart before anyone ───
  // ── notices (e.g. extension host restart under resource pressure). ───────
  setTimeout(() => sweepTerminals(context), 2500);

  // ── Reattach proxy tabs for remote jobs still running on a worker node ───
  // ── (ground truth lives on the worker, so this can't run as part of the ──
  // ── local reindex above). ─────────────────────────────────────────────────
  setTimeout(() => reattachRemoteJobs(context), 2500);

  // ── HTTP server ───────────────────────────────────────────────────────────
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/status') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }

        const entry = JSON.stringify({ ...payload, ts: new Date().toISOString() });
        const folders = vscode.workspace.workspaceFolders || [];
        const written = [];
        for (const folder of folders) {
          try {
            const sdoDir = path.join(folder.uri.fsPath, '.sdo');
            if (!fs.existsSync(sdoDir)) fs.mkdirSync(sdoDir, { recursive: true });
            fs.appendFileSync(path.join(sdoDir, 'pipeline-state.json'), entry + '\n', 'utf8');
            written.push(folder.uri.fsPath);
          } catch { /* ignore read-only folders */ }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, written }));
      });
      return;
    }

    if (url.pathname === '/open-terminal') {
      const cwd     = url.searchParams.get('cwd')   || undefined;
      const name    = url.searchParams.get('name')  || undefined;
      let cmd       = url.searchParams.get('cmd')   || undefined;
      const colorId = url.searchParams.get('color') || undefined;
      const iconId  = url.searchParams.get('icon')  || undefined;
      // focus=1 steals keyboard focus (old default); omit or focus=0 to preserve focus.
      const stealFocus = url.searchParams.get('focus') === '1';
      // node= offloads cmd to a worker (bin/worker.js) registered in
      // ~/.vscode-terminal-bridge/nodes.json instead of running it locally.
      const node    = url.searchParams.get('node') || undefined;
      const ref     = url.searchParams.get('ref')  || undefined;
      // cmdFile= carries a long/quote-heavy command out of band: the caller
      // writes it to disk and we `bash` the file directly, instead of the
      // command surviving shell-quoting at the call site, URL-encoding, AND
      // re-parsing by the terminal's shell as a single inline string.
      const cmdFile = url.searchParams.get('cmdFile') || undefined;
      if (cmdFile && !cmd) {
        cmd = `bash ${shQuote(cmdFile)}`;
      }

      // effectiveCmd is what actually runs in the local terminal tab — either
      // cmd itself (local job) or a tail script proxying a remote job's
      // status/log back into this tab (remote job).
      let effectiveCmd = cmd;
      let jobId;

      if (node) {
        const nodeCfg = loadNodeRegistry()[node];
        if (!nodeCfg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Unknown node "${node}" — check ~/.vscode-terminal-bridge/nodes.json` }));
          return;
        }
        if (!cmd) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'cmd is required when node= is set' }));
          return;
        }

        jobId = `${name || 'job'}-${Date.now()}`;
        try {
          const { status, json } = await postJson(nodeCfg.host, nodeCfg.port, '/run-job', nodeCfg.token, { jobId, cmd, ref });
          if (status !== 200 || !json || !json.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Failed to start job on node "${node}"`, detail: json }));
            return;
          }
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Could not reach node "${node}": ${err.message}` }));
          return;
        }

        effectiveCmd = `bash ${CLI_INSTALL_DIR}/bridge-tail.sh ${node} ${jobId}`;
      }

      const options = { cwd, name };
      if (colorId) options.color    = new vscode.ThemeColor(colorId);
      if (iconId)  options.iconPath = new vscode.ThemeIcon(iconId);

      const terminal = vscode.window.createTerminal(options);
      // preserveFocus=true by default so spawning a terminal never yanks the
      // cursor out of the editor. Pass focus=1 to explicitly steal focus.
      terminal.show(!stealFocus);

      // Send CLAUDE_TAB_NAME + cmd only after the shell is ready so .zshrc
      // has sourced PATH entries (e.g. claude). Use shell integration event
      // when available; fall back to a 1500ms timeout.
      const sendDeferred = () => {
        if (name) terminal.sendText(`export CLAUDE_TAB_NAME=${JSON.stringify(name)}`);
        // Inject orchestrator env vars so status hooks work inside the terminal.
        terminal.sendText(`export HH_ORCHESTRATOR_ID=${JSON.stringify(name || '')}`);
        terminal.sendText(`export HH_BRIDGE_STATUS_URL="http://127.0.0.1:${activePort}/api/status"`);
        // Pin this terminal (and any subshells it spawns) to the exact port of
        // the window that created it. When the same multi-root workspace is
        // open in several windows, .vscode-bridge-port gets overwritten by
        // whichever window activated last — this env var, inherited down the
        // process tree, lets bridge scripts skip that shared, racy file.
        terminal.sendText(`export VSCODE_BRIDGE_PORT=${activePort}`);
        if (effectiveCmd) terminal.sendText(effectiveCmd);
      };
      if ((name || effectiveCmd) && typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
        let sent = false;
        const fallback = setTimeout(() => { if (!sent) { sent = true; sendDeferred(); } }, 1500);
        const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
          if (e.terminal === terminal && !sent) {
            sent = true;
            clearTimeout(fallback);
            sub.dispose();
            sendDeferred();
          }
        });
      } else if (name || effectiveCmd) {
        setTimeout(sendDeferred, 1500);
      }

      if (name) {
        terminals.set(name, terminal);
        await persistMetadata(context, name, {
          cwd, label: name, baseLabel: name, color: colorId,
          ...(node ? { node, jobId } : {}),
          // Reset the lifecycle stamps explicitly: this is a new terminal even
          // when it reuses the name of one that was never cleanly closed, and
          // inheriting the old entry's createdAt would date it to a session
          // that's gone.
          createdAt: new Date().toISOString(),
          statusChangedAt: null,
          lastHeartbeatAt: null,
        });
        // Persist the real shell PID as an OS-level fallback for cleanup —
        // independent of VS Code's own (sometimes-stale) terminal bookkeeping.
        terminal.processId.then(pid => {
          if (pid) persistMetadata(context, name, { pid });
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, cwd, cmd, color: colorId, icon: iconId, node, jobId }));

    } else if (url.pathname === '/rename-terminal') {
      // Rename a terminal tab via VS Code API — no OSC sequences needed.
      //
      // Modes:
      //   status=<key>  — Bridge looks up the canonical codicon + color for the
      //                   given status, prefixes the label, and sets the color.
      //                   iconPath is NEVER touched (identity icon stays).
      //                   Idempotent: repeated calls with the same status are
      //                   no-ops if the label and color are already correct.
      //   quiet=1       — Silently updates only iconPath and/or color (+ status
      //                   color when status= is combined). No terminal activation,
      //                   no panel flicker. label is not changed.
      //   label=        — Full label override (legacy). Required unless quiet=1
      //                   or status= is provided.
      const name    = url.searchParams.get('name');
      const label   = url.searchParams.get('label') || undefined;
      const colorId = url.searchParams.get('color') || undefined;
      const iconId  = url.searchParams.get('icon')  || undefined;
      const quiet   = url.searchParams.get('quiet') === '1';
      // status= is present in the query string but may be empty string → treat as undefined
      const statusRaw = url.searchParams.has('status') ? url.searchParams.get('status') : undefined;
      const status  = statusRaw || undefined;  // coerce empty string to undefined

      const terminal = name && terminals.get(name);

      if (!terminal) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      // Stamp liveness before any of the paths below can return early — the
      // idempotent no-op return is the most common one during sustained work,
      // and skipping it there would leave a busy agent looking silent.
      await touchHeartbeat(context, name);

      // Validation: need at least one of label, quiet, or status
      if (!quiet && status === undefined && !label) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Provide label=, status=, or quiet=1' }));
        return;
      }

      // ── Route the background-work dimension out of `status` (issue #40) ────
      // Existing hook wiring sends these as status values, and that wiring is
      // in users' settings.json — so the routing happens here rather than
      // demanding everyone rewrite their hooks. `bg-task` always counts up.
      // `task-done` only counts down when something is actually outstanding:
      // it doubles as a manual completion badge on a tab with no pending work,
      // and silently swallowing that would be a regression.
      const bgMetaBefore  = loadMetadata(context)[name] ?? {};
      const pendingBefore = Math.max(0, Number(bgMetaBefore.pendingTasks) || 0);
      const bgOp =
        status === 'bg-task'                          ? 'start'
        : (status === 'task-done' && pendingBefore > 0) ? 'end'
        : null;

      if (bgOp) {
        const bg = await setBgTask(context, name, bgOp);
        const shown = await applyPresentation(context, name, terminal, {
          baseLabelOverride: label,
          explicitColor: colorId,
          iconId,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, name,
          label: shown.effectiveLabel, baseLabel: shown.baseLabel,
          icon: iconId, color: shown.color,
          // The turn state is deliberately untouched — this call carried
          // information about a different dimension.
          status: bgMetaBefore.status ?? null,
          displayStatus: shown.displayStatus,
          bgTask: (bg?.pendingTasks ?? 0) > 0,
          pendingTasks: bg?.pendingTasks ?? pendingBefore,
          noOp: shown.noOp,
        }));
        return;
      }

      // ── Quiet mode ──────────────────────────────────────────────────────────
      // Silent update — no terminal activation, no panel flicker.
      // status= in quiet mode applies the canonical color but does NOT rename
      // the label (label changes require terminal activation).
      if (quiet) {
        if (status !== undefined) {
          await persistMetadata(context, name, { status: status === 'none' ? null : status });
        }
        const quietMeta = loadMetadata(context)[name] ?? {};
        const quietCfg  = (() => {
          const key = displayStatusKey(quietMeta);
          return (key && key !== 'none') ? (STATUS_MAP[key] ?? null) : null;
        })();
        const resolvedColor = colorId ?? quietCfg?.color ?? undefined;

        if (iconId)        terminal.iconPath = new vscode.ThemeIcon(iconId);
        if (resolvedColor) terminal.color    = new vscode.ThemeColor(resolvedColor);
        if (resolvedColor) await persistMetadata(context, name, { color: resolvedColor });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, name, label: null, icon: iconId,
          color: resolvedColor, status: status ?? null, quiet: true,
        }));
        return;
      }

      // ── Normal (label-updating) mode ────────────────────────────────────────
      // Persist the turn state first, then render from the registry — the tab
      // shows a function of BOTH dimensions (see displayStatusKey), so the
      // renderer has to read the stored state rather than just this call's.
      if (status !== undefined) {
        await persistMetadata(context, name, { status: status === 'none' ? null : status });
      }

      const shown = await applyPresentation(context, name, terminal, {
        // status= mode derives the base label from the param or persisted
        // state; legacy label= mode (no status=) means the caller owns the
        // whole string.
        baseLabelOverride: status !== undefined ? label : undefined,
        explicitLabel:     status === undefined ? label : undefined,
        explicitColor:     colorId,
        iconId,
      });

      const after = loadMetadata(context)[name] ?? {};

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, name,
        label: shown.effectiveLabel, baseLabel: shown.baseLabel,
        icon: iconId, color: shown.color,
        status: status ?? null,
        displayStatus: shown.displayStatus,
        bgTask: (Number(after.pendingTasks) || 0) > 0,
        pendingTasks: Math.max(0, Number(after.pendingTasks) || 0),
        ...(shown.noOp ? { noOp: true } : {}),
      }));

    } else if (url.pathname === '/set-note' || url.pathname === '/clear-note') {
      // Worker → orchestrator handoff. Parameter shape mirrors /send-text:
      //   text=      inline note
      //   textFile=  path whose CONTENTS become the note
      const name = url.searchParams.get('name');
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }

      if (url.pathname === '/clear-note') {
        const cleared = await clearNote(context, name);
        if (!cleared) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name, cleared: true, noteUpdatedAt: null }));
        return;
      }

      const noteFile = url.searchParams.get('textFile') || undefined;
      let text = url.searchParams.get('text');
      if (noteFile) {
        try {
          text = fs.readFileSync(noteFile, 'utf8');
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Could not read textFile: ${err.message}`, textFile: noteFile }));
          return;
        }
      }
      if (text === null || text === undefined || text === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Provide text= or textFile= (use /clear-note to remove a note)' }));
        return;
      }

      const stored = await setNote(context, name, text);
      if (!stored) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      // Publishing a note is the agent reporting in, so it counts as liveness.
      await touchHeartbeat(context, name);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, name,
        noteUpdatedAt: stored.noteUpdatedAt,
        bytes: stored.bytes,
        truncated: stored.truncated,
        maxBytes: MAX_NOTE_BYTES,
      }));

    } else if (url.pathname === '/note') {
      // The read half. Deliberately NOT part of /list: an orchestrator polls
      // /list constantly, and inlining N note bodies would make every triage
      // pass expensive. /list carries noteUpdatedAt; bodies are fetched only
      // for the entries that have something new.
      const name = url.searchParams.get('name');
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }
      const meta = loadMetadata(context)[name];
      if (!meta) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, name,
        note: meta.note ?? null,
        noteUpdatedAt: meta.noteUpdatedAt ?? null,
        truncated: meta.noteTruncated ?? false,
        bytes: meta.noteBytes ?? 0,
      }));

    } else if (url.pathname === '/bg-task') {
      // The explicit write path for the background-work dimension, for hooks
      // that can say what they mean rather than borrowing a status value.
      //
      //   op=start   something is now outstanding (TaskCreated, a spawned job)
      //   op=end     one outstanding thing finished (TaskCompleted)
      //   op=clear   reset the count to zero
      //
      // Never touches `status`. A terminal can be blocked on a human AND have
      // work in flight; that pair is the reason these are separate fields.
      const name = url.searchParams.get('name');
      const op   = url.searchParams.get('op') || 'start';

      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }
      if (!['start', 'end', 'clear'].includes(op)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Unknown op "${op}" — use start|end|clear` }));
        return;
      }

      const bg = await setBgTask(context, name, op);
      if (!bg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      // Same liveness signal as /rename-terminal: this is the agent reporting
      // in, so it counts as a heartbeat.
      await touchHeartbeat(context, name);

      const terminal = terminals.get(name);
      let shown = null;
      if (terminal) shown = await applyPresentation(context, name, terminal, {});

      const meta = loadMetadata(context)[name] ?? {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, name, op,
        pendingTasks: bg.pendingTasks,
        bgTask: bg.pendingTasks > 0,
        bgTaskStartedAt: bg.bgTaskStartedAt,
        status: meta.status ?? null,
        displayStatus: shown ? shown.displayStatus : displayStatusKey(meta),
        label: shown ? shown.effectiveLabel : null,
      }));

    } else if (url.pathname === '/close-terminal') {
      const name = url.searchParams.get('name');
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }

      const { outcome, method } = await closeTerminalByName(context, name);

      // not-tracked is a 404 because there was nothing here to act on — but
      // `row-removed` is a 200: the caller asked for the terminal to be gone
      // and it is, even though the process had already exited (issue #41).
      if (outcome === 'not-tracked') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', outcome, name }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, outcome, method }));

    } else if (url.pathname === '/forget-terminal') {
      // Registry-only removal — see forgetTerminal(). Deliberately targeted,
      // unlike /sweep, so clearing one stale row never risks live tabs.
      const name = url.searchParams.get('name');
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }

      const { outcome, wasLive } = await forgetTerminal(context, name);

      if (outcome === 'not-tracked') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', outcome, name }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, outcome, wasLive }));

    } else if (url.pathname === '/send-text') {
      // Inject text into an already-running tracked terminal — see
      // sendTextToTerminal() above for the newline / prompt-state handling.
      //
      //   text=      inline payload (fine for short nudges)
      //   textFile=  path to a file whose CONTENTS are injected. Note this is
      //              NOT /open-terminal's cmdFile=, which turns into
      //              `bash <file>` — running a script is meaningless against a
      //              live TUI. Use this for anything long, multi-line, or
      //              quote-heavy, and for payloads that would blow the URL
      //              length limit inline.
      //   submit=0   stage the text without sending a newline
      //   force=1    send even when the terminal is at an interactive prompt
      //   mode=      auto (default) | paste | literal | join
      const name     = url.searchParams.get('name');
      const textFile = url.searchParams.get('textFile') || undefined;
      let text       = url.searchParams.get('text');

      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }
      if (textFile) {
        try {
          text = fs.readFileSync(textFile, 'utf8');
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Could not read textFile: ${err.message}`, textFile }));
          return;
        }
      }
      if (text === null || text === undefined || text === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Provide text= or textFile=' }));
        return;
      }

      const modeParam = url.searchParams.get('mode') || 'auto';
      if (!['auto', 'paste', 'literal', 'join'].includes(modeParam)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Unknown mode "${modeParam}" — use auto|paste|literal|join` }));
        return;
      }

      const result = await sendTextToTerminal(context, name, text, {
        submit: url.searchParams.get('submit') !== '0',
        force:  url.searchParams.get('force') === '1',
        mode:   modeParam,
      });

      const { code, ...body } = result;
      res.writeHead(result.ok ? 200 : code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));

    } else if (url.pathname === '/sweep') {
      // Cross-reference persisted terminals against ground-truth git worktrees
      // and dispose anything whose worktree no longer exists. Self-healing
      // cleanup for when the in-memory registry has desynced from reality.
      const closed = await sweepTerminals(context);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, closed }));

    } else if (url.pathname === '/add-folder') {
      // Attach a path to the current VS Code workspace without needing the
      // `code` CLI on $PATH. Idempotent — returns ok:true if already attached.
      const p = url.searchParams.get('path');
      if (!p) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path param required' }));
        return;
      }

      const uri = vscode.Uri.file(p);
      const existing = (vscode.workspace.workspaceFolders || []).find(
        f => f.uri.fsPath === uri.fsPath
      );
      if (existing) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: p, added: false, alreadyAttached: true }));
        return;
      }

      const indexParam = url.searchParams.get('index');
      const folderName = url.searchParams.get('name') || undefined;
      const start = (vscode.workspace.workspaceFolders || []).length;
      const index = indexParam !== null ? parseInt(indexParam, 10) : start;

      const ok = vscode.workspace.updateWorkspaceFolders(index, 0, { uri, name: folderName });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, path: p, added: ok, alreadyAttached: false }));

    } else if (url.pathname === '/remove-folder') {
      // Detach a workspace folder by path. Idempotent — returns ok:true if
      // the folder wasn't attached to begin with.
      const p = url.searchParams.get('path');
      if (!p) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path param required' }));
        return;
      }

      const uri = vscode.Uri.file(p);
      const folders = vscode.workspace.workspaceFolders || [];
      const idx = folders.findIndex(f => f.uri.fsPath === uri.fsPath);
      if (idx === -1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: p, removed: false, wasAttached: false }));
        return;
      }

      const ok = vscode.workspace.updateWorkspaceFolders(idx, 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, path: p, removed: ok, wasAttached: true }));

    } else if (url.pathname === '/reindex') {
      // Explicit re-index trigger — useful right after a window reload before
      // the window has been focused, e.g. from a startup script.
      const count = await reindexTerminals(context);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reindexed: count }));

    } else if (url.pathname === '/list') {
      // Read path companion to /open-terminal, /close-terminal, /rename-terminal
      // (all write-only): lets a caller check whether a spawn actually landed
      // and what state it's tracked in, instead of guessing from silence.
      const metadata = loadMetadata(context);
      const liveNames = new Set(vscode.window.terminals.map(t => t.name));
      //
      // Timestamps (v0.18.0+) answer the question status alone can't: not
      // "what state is this in" but "does it need me right now". A terminal at
      // needs-input for 2 minutes and one at needs-input for 2 hours are the
      // same row without them. Entries persisted before v0.18.0 report null
      // rather than a fabricated time — treat null as unknown.
      //
      // `now` is returned alongside so a caller computes ages against the
      // bridge's clock rather than its own.
      const list = Object.entries(metadata).map(([name, meta]) => ({
        name,
        cwd: meta.cwd ?? null,
        label: meta.label ?? name,
        status: meta.status ?? null,
        node: meta.node ?? null,
        jobId: meta.jobId ?? null,
        pid: meta.pid ?? null,
        live: terminals.has(name) || liveNames.has(name),
        pidAlive: isPidAlive(meta.pid),
        createdAt: meta.createdAt ?? null,
        updatedAt: meta.updatedAt ?? null,
        statusChangedAt: meta.statusChangedAt ?? null,
        lastHeartbeatAt: meta.lastHeartbeatAt ?? null,
        // v0.20.0+ — set by /send-text on a submitted send. Compare against
        // lastHeartbeatAt to tell "delivered but not picked up" from
        // "picked up"; see touchLastSend().
        lastSendAt: meta.lastSendAt ?? null,
        // v0.21.0+ — the background-work dimension, tracked separately from
        // status so "waiting on a job I started" stops being reported as
        // "waiting on a human" (issue #40). displayStatus is what the tab
        // actually renders; status is still the raw turn state.
        pendingTasks: Math.max(0, Number(meta.pendingTasks) || 0),
        bgTask: (Number(meta.pendingTasks) || 0) > 0,
        bgTaskStartedAt: meta.bgTaskStartedAt ?? null,
        displayStatus: displayStatusKey(meta),
        // v0.22.0+ — the note's TIMESTAMP only. Bodies are fetched per-entry
        // via /note; inlining them here would make the poll an orchestrator
        // runs constantly proportional to how much everyone has written.
        noteUpdatedAt: meta.noteUpdatedAt ?? null,
        noteBytes: meta.noteBytes ?? 0,
        noteTruncated: meta.noteTruncated ?? false,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, now: new Date().toISOString(), terminals: list }));

    } else if (url.pathname === '/ping') {
      const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        port: activePort,
        ipcHook: process.env.VSCODE_IPC_HOOK || null,
        pid: process.env.VSCODE_PID ? Number(process.env.VSCODE_PID) : null,
        workspaceFolders: folders,
      }));

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // ── Dynamic port binding — try the base port, increment on EADDRINUSE ────
  // VSCODE_BRIDGE_BASE_PORT moves the whole search range (used by the test
  // harness so a headless run never collides with real editor windows).
  let activePort = Number(process.env.VSCODE_BRIDGE_BASE_PORT) || 31415;

  function writePortFiles(port) {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      try {
        fs.writeFileSync(path.join(folder.uri.fsPath, '.vscode-bridge-port'), String(port), 'utf8');
      } catch { /* ignore read-only folders */ }
    }
    // User-level fallback, so callers whose cwd sits outside every workspace
    // folder (agent shells that cd'd to /tmp or a scratch dir, hooks with a
    // stripped environment) can still discover the port. Without this, the
    // shell helper's walk-up from $PWD is the only discovery path and it
    // concludes "no bridge" purely because of where the caller happens to
    // stand — see bin/vscode-bridge.sh's _bridge_active.
    try {
      fs.mkdirSync(PORT_FALLBACK_DIR, { recursive: true });
      fs.writeFileSync(PORT_FALLBACK_PATH, String(port), 'utf8');
    } catch { /* non-fatal — workspace port files remain the primary path */ }
  }

  function removePortFiles() {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      try {
        const p = path.join(folder.uri.fsPath, '.vscode-bridge-port');
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
    try {
      if (fs.existsSync(PORT_FALLBACK_PATH)) fs.unlinkSync(PORT_FALLBACK_PATH);
    } catch { /* ignore */ }
  }

  // Re-write port files when the workspace changes (e.g. /add-folder adds a worktree folder)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => writePortFiles(activePort))
  );

  // The port we're currently trying to bind. Distinct from activePort, which
  // is only assigned once a bind SUCCEEDS: retrying from activePort meant every
  // EADDRINUSE re-tried the same port forever, so a third window (31415 and
  // 31416 already taken) never bound at all and never wrote a port file.
  let candidatePort = activePort;
  const MAX_PORT_ATTEMPTS = 32;
  let portAttempts = 0;

  // One persistent 'listening' handler rather than a per-attempt callback:
  // server.listen(port, cb) registers cb as a one-shot listener that never
  // fires if that attempt hits EADDRINUSE, so a retry loop accumulates dead
  // listeners which then ALL fire together on the eventual success — each
  // logging and writing a port file for a port we aren't actually bound to.
  server.on('listening', () => {
    activePort = server.address().port;
    console.log(`[terminal-bridge] listening on 127.0.0.1:${activePort}`);
    writePortFiles(activePort);
  });

  function startServer(port) {
    candidatePort = port;
    server.listen(port, '127.0.0.1');
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (++portAttempts > MAX_PORT_ATTEMPTS) {
        console.error(
          `[terminal-bridge] no free port in ${activePort}–${candidatePort}; bridge not listening`
        );
        return;
      }
      startServer(candidatePort + 1);
    } else {
      console.error('[terminal-bridge] server error:', err.message);
    }
  });

  startServer(candidatePort);

  context.subscriptions.push({ dispose: () => { removePortFiles(); server && server.close(); } });
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
