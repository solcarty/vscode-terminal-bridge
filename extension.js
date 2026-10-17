// The VS Code entry point. The bridge itself — registry, HTTP server, every
// route — lives in bridge.js and is shared with headless.js (#77); this file is
// the VS Code backend for it (`vscodeHost`), the two side-panel views, and the
// check that defers to a headless bridge already serving this host.
const vscode = require('vscode');
const fs = require('fs');
const http = require('http');
const path = require('path');
const bridge = require('./bridge');
const { createPanel, SHOW_COMMAND } = require('./panel');
const { createHostsPanel, SETTING: HOSTS_SETTING } = require('./hosts');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The VS Code backend: bridge.js's `host`, over vscode.window terminals.
// ---------------------------------------------------------------------------

function vscodeHost() {
  const folders = () => (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  return {
    kind: 'vscode',
    get terminals() { return vscode.window.terminals; },

    createTerminal({ name, cwd, color, icon }) {
      const options = { cwd, name };
      if (color) options.color    = new vscode.ThemeColor(color);
      if (icon)  options.iconPath = new vscode.ThemeIcon(icon);
      return vscode.window.createTerminal(options);
    },

    // Shell integration (VS Code 1.93+) says when the shell has started; without
    // it, or when it never fires, the command is written blind.
    whenShellReady(terminal, fallbackMs) {
      if (typeof vscode.window.onDidChangeTerminalShellIntegration !== 'function') {
        return sleep(1500).then(() => 'timeout');
      }
      return new Promise(resolve => {
        let done = false;
        const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
          if (e.terminal === terminal && !done) {
            done = true;
            clearTimeout(fallback);
            sub.dispose();
            resolve('shell-integration');
          }
        });
        const fallback = setTimeout(() => {
          if (!done) { done = true; sub.dispose(); resolve('timeout'); }
        }, fallbackMs);
      });
    },

    onDidCloseTerminal: cb => vscode.window.onDidCloseTerminal(cb),

    // Window focus catches reload → user clicks back; shell integration
    // activating is when a revived tab's cwd becomes readable.
    onShouldReindex(cb) {
      const subs = [vscode.window.onDidChangeWindowState(state => { if (state.focused) cb(); })];
      if (typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
        subs.push(vscode.window.onDidChangeTerminalShellIntegration(() => cb()));
      }
      return { dispose: () => subs.forEach(s => s.dispose()) };
    },

    workspaceFolders: folders,
    workspaceName: () => vscode.workspace.name || null,
    getSetting: (key, def) => vscode.workspace.getConfiguration('terminalBridge').get(key, def),
    addFolder: (p, index, name) =>
      vscode.workspace.updateWorkspaceFolders(index, 0, { uri: vscode.Uri.file(p), name }),
    removeFolder: p => {
      const idx = folders().indexOf(vscode.Uri.file(p).fsPath);
      return idx !== -1 && vscode.workspace.updateWorkspaceFolders(idx, 1);
    },
    onDidChangeWorkspaceFolders: cb => vscode.workspace.onDidChangeWorkspaceFolders(cb),

    pid: process.env.VSCODE_PID ? Number(process.env.VSCODE_PID) : process.pid,
    pingFields: () => ({
      ipcHook: process.env.VSCODE_IPC_HOOK || null,
      pid: process.env.VSCODE_PID ? Number(process.env.VSCODE_PID) : null,
    }),
    rowFields: () => ({}),
  };
}

// ---------------------------------------------------------------------------
// Deferring to a headless bridge (#77)
//
// One bridge per host. A Remote-SSH window opening on a host whose headless
// bridge is already up must not start a second server: two bridges on adjacent
// ports split the host's terminals between them, and every caller's port
// discovery picks one of the two at random. So the window becomes a viewer of
// the headless bridge instead — its Terminals panel lists the headless rows and
// a click attaches a VS Code terminal to the tmux session.
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 500;
const VIEWER_POLL_MS = Number(process.env.VSCODE_BRIDGE_VIEWER_POLL_MS) || 3000;

function getLocal(port, urlPath, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Candidate ports: presence entries a headless bridge wrote, then the shared
// port file. Only a /ping that answers `backend: "tmux"` counts — a port file
// left by another VS Code window, or a dead headless entry, is not a reason to
// stop serving.
async function findHeadlessBridge() {
  const ports = [];
  try {
    for (const f of fs.readdirSync(bridge.BRIDGES_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(bridge.BRIDGES_DIR, f), 'utf8'));
        if (entry.backend === 'tmux' && bridge.isPidAlive(entry.pid) !== false) ports.push(Number(entry.port));
      } catch { /* unreadable entry */ }
    }
  } catch { /* no presence registry */ }
  try { ports.push(Number(fs.readFileSync(bridge.PORT_FALLBACK_PATH, 'utf8').trim())); } catch { /* no port file */ }

  for (const port of [...new Set(ports)].filter(p => p > 0)) {
    const ping = await getLocal(port, '/ping');
    if (ping && ping.ok && ping.backend === 'tmux') return { ...ping, port };
  }
  return null;
}

// The viewer side: poll the headless /list, hand its rows to the Terminals
// panel, and attach on click. Writes nothing to the headless registry.
function startViewer(context, headless, panel) {
  bridge.writePortFiles((vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath), headless.port);

  const attached = new Map();   // name → the VS Code terminal attached to its session
  let rows = {};
  let failing = false;

  const viewer = {
    port: headless.port,
    get metadata() { return rows; },
    isLive: name => rows[name]?.live !== false,
    show(name) {
      const existing = attached.get(name);
      if (existing && vscode.window.terminals.includes(existing)) { existing.show(); return existing; }
      const session = rows[name]?.tmuxSession;
      if (!session) return null;
      // `=` makes the target an exact session name, so `feat-1` never
      // attaches to `feat-10`.
      const terminal = vscode.window.createTerminal({
        name,
        shellPath: 'tmux',
        shellArgs: ['-L', headless.tmuxSocket, 'attach-session', '-t', `=${session}`],
      });
      attached.set(name, terminal);
      terminal.show();
      return terminal;
    },
  };

  // #83 — a window older or newer than the headless bridge it defers to is
  // easy to miss, so say so once in the log and keep both versions in the
  // panel description. A headless bridge that reports no version predates
  // the field, which is skew too.
  const ownVersion = bridge.VERSION;
  const skew = headless.version !== ownVersion
    ? ` · headless v${headless.version || '?'} ≠ window v${ownVersion}` : '';
  if (skew) {
    console.warn(`[terminal-bridge] headless bridge on ${headless.port} is v${headless.version || '?'}, this window's extension is v${ownVersion}`);
  }

  async function poll() {
    const list = await getLocal(headless.port, '/list', 2000);
    if (list && list.ok) {
      rows = Object.fromEntries(list.terminals.map(t => [t.name, t]));
      failing = false;
    } else if (!failing) {
      failing = true;
      console.error(`[terminal-bridge] headless bridge on ${headless.port} stopped answering; reload the window to serve locally`);
    }
    if (panel) {
      panel.view.description = (failing ? `headless bridge on ${headless.port} not answering` : `headless · ${headless.port}`) + skew;
      panel.refresh();
    }
  }

  poll();
  const timer = setInterval(poll, VIEWER_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  console.log(`[terminal-bridge] deferring to the headless bridge on 127.0.0.1:${headless.port}`);
  return viewer;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

let viewer = null;

function activate(context) {
  // ── Side panel: every tracked terminal with its status and progress. ──────
  // A panel that fails to build must not take the HTTP server down with it.
  let panel = null;
  try {
    panel = createPanel(vscode, context, {
      loadMetadata: () => bridge.loadMetadata(context),
      statusMap: bridge.STATUS_MAP,
      displayStatusKey: bridge.displayStatusKey,
      terminals: bridge.terminals,
      onDidWrite: bridge.onDidWriteMetadata,
      source: () => viewer,
    });
  } catch (err) {
    console.error('[terminal-bridge] side panel failed to register:', err);
  }

  // ── All hosts view: every host's terminals, from terminalBridge.hostsCommand.
  // Read only, and it runs its command only while the view is on screen.
  try {
    createHostsPanel(vscode, context, {
      statusMap: bridge.STATUS_MAP,
      displayStatusKey: bridge.displayStatusKey,
      getCommand: () => String(vscode.workspace.getConfiguration('terminalBridge').get(HOSTS_SETTING, '') ?? '').trim(),
      showLocal: name => vscode.commands.executeCommand(SHOW_COMMAND, name),
    });
  } catch (err) {
    console.error('[terminal-bridge] all hosts view failed to register:', err);
  }

  // ── Serve, unless a headless bridge already does on this host. ────────────
  // A failed probe falls through to serving: a window with no bridge at all is
  // the outcome this must never produce.
  return findHeadlessBridge()
    .catch(() => null)
    .then(headless => {
      if (headless) viewer = startViewer(context, headless, panel);
      else bridge.startBridge(vscodeHost(), context);
    });
}

function deactivate() {
  bridge.stopBridge();
}

module.exports = { activate, deactivate, findHeadlessBridge };
