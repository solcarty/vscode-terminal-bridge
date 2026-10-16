#!/usr/bin/env node
// The headless bridge (#77): bridge.js with tmux sessions as its terminals, so
// a host runs a bridge all the time with no VS Code window open. Same routes,
// same registry fields, same port files and bundled CLI as the extension — the
// only thing that differs is this file's `host`.
//
//   node headless.js [--folder <path>]... [--agent-id <id>] [--socket <name>]
//
// Folders also come from VSCODE_BRIDGE_FOLDERS (colon-separated), the tmux
// socket from VSCODE_BRIDGE_TMUX_SOCKET (default `vscode-bridge`). Run under
// systemd with systemd/vscode-terminal-bridge.service; see the README,
// "Headless mode".
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bridge = require('./bridge');

const TMUX = process.env.VSCODE_BRIDGE_TMUX || 'tmux';
const POLL_MS = Number(process.env.VSCODE_BRIDGE_TMUX_POLL_MS) || 2000;
const STATE_DIR = path.join(os.homedir(), '.vscode-terminal-bridge', 'headless');
const REGISTRY_PATH = path.join(STATE_DIR, 'registry.json');

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

// tmux reports a missing server two ways depending on version; both mean
// "no sessions", which is a confirmed answer, not a failed read.
const NO_SERVER = /no server running|error connecting to|no such file or directory/i;

// One tmux command on our socket. Rejects with stderr on a non-zero exit.
function tmuxRun(socket, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(TMUX, ['-L', socket, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(stderr.trim() || `tmux exited ${code}`), { stderr }));
    });
    // tmux can exit before reading stdin (no server yet); the write then fails
    // with EPIPE. Not a failure: the result comes from the exit code and stderr.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// tmux turns `.` and `:` in a session name into `_`, and they mean something
// in a target. The real name rides along in the @bridge_name session option.
function sessionNameFor(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_') || 'terminal';
}

// ---------------------------------------------------------------------------
// The tmux backend: bridge.js's `host`, over the sessions on one tmux socket.
//
// A dedicated socket (`tmux -L vscode-bridge`) keeps the bridge's sessions
// apart from the user's own: list, sweep and reindex only ever see sessions
// the bridge made, and a person's `tmux ls` stays theirs.
// ---------------------------------------------------------------------------

function tmuxHost({ socket, folders = [], settings = {} }) {
  const run = (args, input) => tmuxRun(socket, args, input);
  let list = [];
  const closeCbs = new Set();
  const reindexCbs = new Set();
  const folderCbs = new Set();
  // Sessions being killed: a refresh that still lists one must not revive it,
  // and a new terminal reusing the name waits for the kill to finish.
  const killing = new Map();
  let clock = 0;
  let bufferSeq = 0;

  const subscribe = set => cb => { set.add(cb); return { dispose: () => set.delete(cb) }; };
  const fire = (set, arg) => set.forEach(cb => { try { cb(arg); } catch (err) { console.error('[terminal-bridge] listener failed:', err); } });

  class TmuxTerminal {
    constructor(name, session, ready) {
      this.name = name;
      this.session = session;
      this.ready = ready;
      this.readyAt = null;
      // Writes go out in order: sendText is fire-and-forget like VS Code's, but
      // `export …` then the command must reach the shell in that order.
      this.queue = Promise.resolve();
      this.processId = ready.then(pid => pid, () => undefined);
    }

    get target() { return `=${this.session}:`; }

    sendText(text, addNewline = true) {
      // A terminal whose session never started has already closed; there is
      // nothing to write to.
      this.queue = this.queue.then(() => this.ready.then(() => true, () => false)).then(async started => {
        if (!started) return;
        const raw = String(text);
        // The bridge brackets a multi-line send itself; tmux's paste-buffer -p
        // does the same thing, and only when the app asked for bracketed paste.
        const bracketed = raw.length >= PASTE_START.length + PASTE_END.length
          && raw.startsWith(PASTE_START) && raw.endsWith(PASTE_END);
        const body = bracketed ? raw.slice(PASTE_START.length, raw.length - PASTE_END.length) : raw;
        if (body) {
          const buffer = `bridge-${process.pid}-${++bufferSeq}`;
          await run(['load-buffer', '-b', buffer, '-'], body);
          await run(['paste-buffer', '-d', ...(bracketed ? ['-p'] : []), '-b', buffer, '-t', this.target]);
        }
        if (addNewline) await run(['send-keys', '-t', this.target, 'Enter']);
      }).catch(err => console.error(`[terminal-bridge] send to ${this.name} failed: ${err.message}`));
    }

    show() { /* nothing to show: a person attaches with `tmux attach` */ }

    dispose() {
      list = list.filter(t => t !== this);
      const kill = this.ready.catch(() => {})
        .then(() => run(['kill-session', '-t', `=${this.session}`]))
        .catch(() => { /* already gone */ })
        .finally(() => { if (killing.get(this.session) === kill) killing.delete(this.session); });
      killing.set(this.session, kill);
    }
  }

  // Bring the list in line with what tmux has: sessions that vanished close
  // (the bridge drops their rows, as VS Code does when a tab's shell exits),
  // sessions that appeared are adopted so reindex can bind them by name.
  // Resolves true when tmux answered — including "no server", which after a
  // reboot is exactly the answer — and false when it couldn't be asked.
  async function refresh() {
    const startedAt = ++clock;
    let out;
    try {
      out = await run(['list-sessions', '-F', '#{session_name}\t#{pane_pid}\t#{@bridge_name}']);
    } catch (err) {
      if (err.code === 'ENOENT' || !NO_SERVER.test(err.stderr || '')) return false;
      out = '';
    }
    const seen = new Map();
    for (const line of out.split('\n').filter(Boolean)) {
      const [session, pid, bridgeName] = line.split('\t');
      seen.set(session, { pid: Number(pid) || undefined, name: bridgeName || session });
    }

    for (const t of [...list]) {
      // A terminal created after this read began isn't in it yet.
      if (t.readyAt === null || t.readyAt > startedAt || seen.has(t.session)) continue;
      list = list.filter(x => x !== t);
      fire(closeCbs, t);
    }

    let adopted = 0;
    for (const [session, { pid, name }] of seen) {
      if (killing.has(session) || list.some(t => t.session === session)) continue;
      const t = new TmuxTerminal(name, session, Promise.resolve(pid));
      t.readyAt = startedAt;
      list.push(t);
      adopted++;
    }
    for (const session of killing.keys()) if (!seen.has(session)) killing.delete(session);
    if (adopted) fire(reindexCbs);
    return true;
  }

  const host = {
    kind: 'tmux',
    socket,
    get terminals() { return list; },
    refresh,

    createTerminal({ name, cwd }) {
      let session = sessionNameFor(name);
      for (let i = 2; list.some(t => t.session === session); i++) session = `${sessionNameFor(name)}-${i}`;
      const ready = (killing.get(session) || Promise.resolve())
        .then(() => run([
          'new-session', '-d', '-s', session, '-x', '220', '-y', '50',
          ...(cwd ? ['-c', cwd] : []),
          '-P', '-F', '#{pane_pid}',
          // A pane-style target: set-option resolves `=name` alone as a pane.
          ';', 'set-option', '-t', `=${session}:`, '@bridge_name', String(name),
        ]))
        .then(out => Number(out.trim().split('\n')[0]) || undefined);
      const terminal = new TmuxTerminal(String(name), session, ready);
      list.push(terminal);
      ready.then(() => { terminal.readyAt = ++clock; }, err => {
        console.error(`[terminal-bridge] tmux new-session ${session} failed: ${err.message}`);
        if (list.includes(terminal)) {
          list = list.filter(t => t !== terminal);
          fire(closeCbs, terminal);
        }
      });
      return terminal;
    },

    // A pane has no shell-integration signal, but it does have a cursor: a
    // shell waiting at its prompt leaves it after the prompt, mid-line. Startup
    // noise (an rc file's error) ends in a newline, so it doesn't count.
    async whenShellReady(terminal, fallbackMs) {
      const deadline = Date.now() + fallbackMs;
      try { await terminal.ready; } catch { return 'timeout'; }
      while (Date.now() < deadline) {
        try {
          const cursorX = await run(['display-message', '-p', '-t', terminal.target, '#{cursor_x}']);
          if (Number(cursorX.trim()) > 0) return 'prompt';
        } catch { /* session not answering yet */ }
        await new Promise(r => setTimeout(r, 100));
      }
      return 'timeout';
    },

    async capturePane(terminal, lines) {
      await terminal.ready;
      const out = await run(['capture-pane', '-p', '-J', '-t', terminal.target, '-S', `-${lines}`]);
      return out.replace(/\s+$/, '');
    },

    onDidCloseTerminal: subscribe(closeCbs),
    onShouldReindex: subscribe(reindexCbs),

    workspaceFolders: () => [...folders],
    workspaceName: () => settings.workspaceName || null,
    getSetting: (key, def) => (settings[key] !== undefined && settings[key] !== '' ? settings[key] : def),
    addFolder(p, index) {
      if (folders.includes(p)) return true;
      folders.splice(Math.max(0, Math.min(index, folders.length)), 0, p);
      fire(folderCbs);
      return true;
    },
    removeFolder(p) {
      const i = folders.indexOf(p);
      if (i === -1) return false;
      folders.splice(i, 1);
      fire(folderCbs);
      return true;
    },
    onDidChangeWorkspaceFolders: subscribe(folderCbs),

    pid: process.pid,
    pingFields: () => ({ pid: process.pid, tmuxSocket: socket }),
    rowFields: (name, terminal) => ({
      tmuxSession: terminal && list.includes(terminal) ? terminal.session : null,
    }),
  };
  return host;
}

// ---------------------------------------------------------------------------
// The registry's store: workspaceState's get/update over one JSON file, so a
// restarted bridge finds the rows its sessions belong to.
// ---------------------------------------------------------------------------

function fileState(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  return {
    get: key => data[key],
    update(key, value) {
      data[key] = value;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        console.error('[terminal-bridge] could not write the registry:', err.message);
      }
      return Promise.resolve();
    },
  };
}

function parseArgs(argv, env = process.env) {
  const opts = {
    folders: (env.VSCODE_BRIDGE_FOLDERS || '').split(':').filter(Boolean),
    socket: env.VSCODE_BRIDGE_TMUX_SOCKET || 'vscode-bridge',
    settings: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--folder') opts.folders.push(value());
    else if (flag === '--socket') opts.socket = value();
    else if (flag === '--agent-id') opts.settings.agentId = value();
    else if (flag === '--pipeline-state-dir') opts.settings.pipelineStateDir = value();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  opts.folders = [...new Set(opts.folders.map(f => path.resolve(f)))];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const host = tmuxHost(opts);
  const context = {
    extensionPath: __dirname,
    subscriptions: [],
    workspaceState: fileState(REGISTRY_PATH),
  };

  // Rows whose session is gone are dropped before anything reads them: after
  // a reboot the tmux server is gone and so are its terminals, and listing
  // them would be inventing terminals that no longer exist. Only a confirmed
  // answer from tmux prunes; if tmux can't be asked, the rows stay and the
  // poller settles them once it can. Remote-job rows are left for
  // reattachRemoteJobs, whose ground truth is the worker, not tmux.
  if (await host.refresh()) {
    const meta = bridge.loadMetadata(context);
    const live = new Set(host.terminals.map(t => t.name));
    const gone = Object.keys(meta).filter(name => !live.has(name) && !meta[name].node);
    if (gone.length) {
      for (const name of gone) delete meta[name];
      await context.workspaceState.update('terminalBridgeMetadata', meta);
      console.log(`[terminal-bridge] dropped ${gone.length} row(s) whose tmux session is gone: ${gone.join(', ')}`);
    }
  } else {
    console.error(`[terminal-bridge] could not run ${TMUX}; rows kept until it answers`);
  }

  bridge.startBridge(host, context);

  const poller = setInterval(() => host.refresh().catch(() => {}), POLL_MS);
  const stop = () => {
    clearInterval(poller);
    for (const sub of context.subscriptions) { try { sub.dispose(); } catch { /* best effort */ } }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('unhandledRejection', err => console.error('[terminal-bridge] unhandled rejection:', err));
}

if (require.main === module) {
  main().catch(err => { console.error('[terminal-bridge] headless bridge failed to start:', err); process.exit(1); });
}

module.exports = { tmuxRun, tmuxHost, fileState, parseArgs, sessionNameFor };
