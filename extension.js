const vscode = require('vscode');
const http = require('http');
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
// Metadata helpers — keep workspaceState in sync with the in-memory map.
// Stored shape: { [name]: { cwd?, label?, color? } }
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

async function parseWorktrees() {
  // Returns Map<absolutePath, name> where name is the last path segment.
  // e.g. '/Users/…/worktrees/vscode-terminal-bridge/issue-11' → 'issue-11'
  try {
    const { stdout } = await execAsync('git worktree list --porcelain');
    const worktrees = new Map();
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const p = line.slice(9).trim();
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
  const metadata  = loadMetadata(context);       // name → { cwd, label, color }
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
        const name = cwdToName[cwd] ?? worktrees.get(cwd);
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

  // ── HTTP server ───────────────────────────────────────────────────────────
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/open-terminal') {
      const cwd     = url.searchParams.get('cwd')   || undefined;
      const name    = url.searchParams.get('name')  || undefined;
      const cmd     = url.searchParams.get('cmd')   || undefined;
      const colorId = url.searchParams.get('color') || undefined;
      const iconId  = url.searchParams.get('icon')  || undefined;

      const options = { cwd, name };
      if (colorId) options.color    = new vscode.ThemeColor(colorId);
      if (iconId)  options.iconPath = new vscode.ThemeIcon(iconId);

      const terminal = vscode.window.createTerminal(options);
      terminal.show(false);
      if (cmd) terminal.sendText(cmd);
      if (name) {
        terminals.set(name, terminal);
        await persistMetadata(context, name, { cwd, label: name, color: colorId });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, cwd, cmd, color: colorId, icon: iconId }));

    } else if (url.pathname === '/rename-terminal') {
      // Rename a terminal tab via VS Code API — no OSC sequences needed.
      // Called by /linear-process at each phase boundary to update label, icon, and color.
      //
      // Phase → label/icon/color convention (emoji goes at the front of the label):
      //   setup       label="🔧 SOL-XX"  icon=hubot  color=terminal.ansiCyan
      //   planning    label="📋 SOL-XX"  icon=hubot  color=terminal.ansiCyan
      //   coding      label="⚙️ SOL-XX"  icon=hubot  color=terminal.ansiCyan
      //   in progress label="▶️ SOL-XX"  icon=hubot  color=terminal.ansiCyan
      //   blocked     label="🚫 SOL-XX"  icon=error  color=terminal.ansiRed
      //   done        label="✅ SOL-XX"  icon=check  color=terminal.ansiGreen
      //
      // The hubot icon is set at terminal creation (/open-terminal) and persists
      // as the subagent identity marker. icon= here overrides only for terminal states.
      const name    = url.searchParams.get('name');
      const label   = url.searchParams.get('label');
      const colorId = url.searchParams.get('color') || undefined;
      const iconId  = url.searchParams.get('icon')  || undefined;
      const terminal = name && terminals.get(name);

      if (!terminal) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      if (!label) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'label param required' }));
        return;
      }

      // Only switch the active terminal if needed.
      // Use show(true) = preserveFocus so keyboard focus is NEVER stolen.
      const prev = vscode.window.activeTerminal;
      const needsSwitch = prev !== terminal;
      if (needsSwitch) terminal.show(true);
      await vscode.commands.executeCommand(
        'workbench.action.terminal.renameWithArg',
        { name: label }
      );
      if (needsSwitch && prev) prev.show(true);

      if (iconId)  terminal.iconPath = new vscode.ThemeIcon(iconId);
      if (colorId) terminal.color    = new vscode.ThemeColor(colorId);

      // Persist updated label + color so they survive a reload.
      await persistMetadata(context, name, { label, color: colorId });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, label, icon: iconId, color: colorId }));

    } else if (url.pathname === '/close-terminal') {
      const name = url.searchParams.get('name');
      const terminal = name && terminals.get(name);

      if (!terminal) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      terminal.dispose();
      terminals.delete(name);
      await persistMetadata(context, name, null);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name }));

    } else if (url.pathname === '/reindex') {
      // Explicit re-index trigger — useful right after a window reload before
      // the window has been focused, e.g. from a startup script.
      const count = await reindexTerminals(context);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reindexed: count }));

    } else if (url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ipcHook: process.env.VSCODE_IPC_HOOK || null,
        pid: process.env.VSCODE_PID ? Number(process.env.VSCODE_PID) : null,
      }));

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(31415, '127.0.0.1', () => {
    console.log('[terminal-bridge] listening on 127.0.0.1:31415');
  });

  server.on('error', (err) => {
    console.error('[terminal-bridge] server error:', err.message);
  });

  context.subscriptions.push({ dispose: () => server && server.close() });
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
