const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

let server;

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

async function persistMetadata(context, name, update) {
  const meta = loadMetadata(context);
  if (update === null) {
    delete meta[name];
  } else {
    meta[name] = { ...meta[name], ...update };
  }
  await context.workspaceState.update(METADATA_KEY, meta);
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
// ---------------------------------------------------------------------------

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
    return { found: true, method: 'dispose' };
  }

  // Registry has no live terminal object — fall back to killing by persisted PID.
  const meta = loadMetadata(context)[name];
  if (meta && meta.pid) {
    try {
      process.kill(meta.pid, 'SIGTERM');
      terminals.delete(name);
      await persistMetadata(context, name, null);
      return { found: true, method: 'pid-kill' };
    } catch { /* already dead — fall through to not-found */ }
  }

  return { found: false, method: null };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

function activate(context) {
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
      const cmd     = url.searchParams.get('cmd')   || undefined;
      const colorId = url.searchParams.get('color') || undefined;
      const iconId  = url.searchParams.get('icon')  || undefined;
      // focus=1 steals keyboard focus (old default); omit or focus=0 to preserve focus.
      const stealFocus = url.searchParams.get('focus') === '1';

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
        if (cmd) terminal.sendText(cmd);
      };
      if ((name || cmd) && typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
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
      } else if (name || cmd) {
        setTimeout(sendDeferred, 1500);
      }

      if (name) {
        terminals.set(name, terminal);
        await persistMetadata(context, name, { cwd, label: name, baseLabel: name, color: colorId });
        // Persist the real shell PID as an OS-level fallback for cleanup —
        // independent of VS Code's own (sometimes-stale) terminal bookkeeping.
        terminal.processId.then(pid => {
          if (pid) persistMetadata(context, name, { pid });
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, cwd, cmd, color: colorId, icon: iconId }));

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

      // Validation: need at least one of label, quiet, or status
      if (!quiet && status === undefined && !label) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Provide label=, status=, or quiet=1' }));
        return;
      }

      // Resolve status config (null for status='none' or unknown status values)
      const statusCfg = (status && status !== 'none') ? (STATUS_MAP[status] ?? null) : null;
      // Resolved color: explicit param wins over status default
      const resolvedColor = colorId ?? statusCfg?.color ?? undefined;

      // ── Quiet mode ──────────────────────────────────────────────────────────
      // Silent update — no terminal activation, no panel flicker.
      // status= in quiet mode applies the canonical color but does NOT rename
      // the label (label changes require terminal activation).
      if (quiet) {
        if (iconId)        terminal.iconPath = new vscode.ThemeIcon(iconId);
        if (resolvedColor) terminal.color    = new vscode.ThemeColor(resolvedColor);

        const metaUpdate = {};
        if (resolvedColor) metaUpdate.color = resolvedColor;
        if (status !== undefined) metaUpdate.status = status === 'none' ? null : status;
        if (Object.keys(metaUpdate).length) await persistMetadata(context, name, metaUpdate);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, name, label: null, icon: iconId,
          color: resolvedColor, status: status ?? null, quiet: true,
        }));
        return;
      }

      // ── Normal (label-updating) mode ────────────────────────────────────────
      const meta = loadMetadata(context);
      const termMeta = meta[name] ?? {};

      let effectiveLabel, baseLabel;

      if (status !== undefined) {
        // status= mode: derive baseLabel from explicit label param or persisted state.
        baseLabel = label ?? termMeta.baseLabel ?? termMeta.label ?? name;
        effectiveLabel = statusCfg
          ? `$(${statusCfg.codicon}) ${baseLabel}`
          : baseLabel;  // status='none' or unknown → strip prefix
      } else {
        // Legacy mode: label= is the full effective label.
        baseLabel     = label;
        effectiveLabel = label;
      }

      // Idempotency: skip the rename round-trip if nothing actually changed.
      const prevEffLabel = termMeta.effectiveLabel;
      const prevColor    = termMeta.color;
      const labelChanged = effectiveLabel !== prevEffLabel;
      const colorChanged = resolvedColor !== prevColor;

      if (!labelChanged && !colorChanged && !iconId) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, name, label: effectiveLabel, baseLabel,
          icon: iconId, color: resolvedColor, status: status ?? null, noOp: true,
        }));
        return;
      }

      // Perform the rename only when the label actually changed.
      if (labelChanged) {
        // Only switch the active terminal if needed.
        // Use show(true) = preserveFocus so keyboard focus is NEVER stolen.
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

      // Preserve the status field if no new status was provided.
      const persistedStatus = status !== undefined
        ? (status === 'none' ? null : status)
        : termMeta.status;

      await persistMetadata(context, name, {
        label: effectiveLabel,
        baseLabel,
        status: persistedStatus,
        effectiveLabel,
        color: resolvedColor,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, name, label: effectiveLabel, baseLabel,
        icon: iconId, color: resolvedColor, status: status ?? null,
      }));

    } else if (url.pathname === '/close-terminal') {
      const name = url.searchParams.get('name');
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name param required' }));
        return;
      }

      const { found, method } = await closeTerminalByName(context, name);

      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, method }));

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

  // ── Dynamic port binding — try 31415, increment on EADDRINUSE ───────────
  let activePort = 31415;

  function writePortFiles(port) {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      try {
        fs.writeFileSync(path.join(folder.uri.fsPath, '.vscode-bridge-port'), String(port), 'utf8');
      } catch { /* ignore read-only folders */ }
    }
  }

  function removePortFiles() {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      try {
        const p = path.join(folder.uri.fsPath, '.vscode-bridge-port');
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  }

  // Re-write port files when the workspace changes (e.g. /add-folder adds a worktree folder)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => writePortFiles(activePort))
  );

  function startServer(port) {
    server.listen(port, '127.0.0.1', () => {
      activePort = port;
      console.log(`[terminal-bridge] listening on 127.0.0.1:${port}`);
      writePortFiles(port);
    });
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      startServer(activePort + 1);
    } else {
      console.error('[terminal-bridge] server error:', err.message);
    }
  });

  startServer(activePort);

  context.subscriptions.push({ dispose: () => { removePortFiles(); server && server.close(); } });
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
