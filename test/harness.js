// Headless harness: loads extension.js with a mocked `vscode` module so the
// bridge's HTTP surface can be driven from plain node — no VS Code, no VSIX
// install, no window reload.
//
// The bridge under test runs IN THIS PROCESS. A test that shells out to the
// bundled CLI must therefore spawn it asynchronously — spawnSync blocks the
// event loop that would answer the CLI's HTTP request, so its curl times out
// and the command silently no-ops (which is what every bridge verb does when
// it can't reach a bridge, so the test fails looking like a product bug).
//
// Always run through `npm test` (test/run.js). It points $HOME at a throwaway
// directory and moves the port range, because activate() writes
// ~/.vscode-terminal-bridge/port and binds from 31415 — against a real $HOME
// a test run would hand every agent shell on the machine the harness's port.
// The guard below refuses to run without that setup rather than trusting it.
const Module = require('module');
const path = require('path');
const fs = require('fs');

if (!process.env.VSCODE_BRIDGE_TEST_HOME || process.env.HOME !== process.env.VSCODE_BRIDGE_TEST_HOME) {
  throw new Error('test harness must be run via `npm test` (needs a throwaway $HOME)');
}

const state = new Map();
const disposed = [];
let terminalsInWindow = [];

const renames = [];
let activeTerminal = null;
// How show() behaves. Real VS Code activates asynchronously (the ext host
// RPCs the main thread), so a test can delay activation to open the race
// window, or swallow it entirely to model a show() that never takes effect.
const showBehavior = { delayMs: 0, ignore: false };
let shellIntegrationCbs = [];
let closeCbs = [];
let openCbs = [];
// The side panel's registrations, so a test can assert the view exists and
// drive its provider and commands without a VS Code window.
const treeViews = [];
const registeredCommands = new Map();
// Every executeCommand call, and what the clipboard was given, so the All hosts
// view's clicks can be asserted.
const executedCommands = [];
const clipboard = { text: null };
let configCbs = [];

class EventEmitter {
  constructor() { this.listeners = []; this.fired = 0; }
  get event() {
    return listener => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
  }
  fire(e) { this.fired++; this.listeners.forEach(l => l(e)); }
  dispose() { this.listeners = []; }
}

const vscodeMock = {
  commands: {
    // VS Code renames whichever terminal is active, so a rename is recorded
    // against activeTerminal. The bridge no longer issues any; tests assert
    // this list stays empty.
    executeCommand: (cmd, arg, ...rest) => {
      executedCommands.push({ cmd, args: [arg, ...rest] });
      if (registeredCommands.has(cmd)) return Promise.resolve(registeredCommands.get(cmd)(arg, ...rest));
      if (cmd === 'workbench.action.terminal.renameWithArg') {
        renames.push({ terminal: activeTerminal?.name ?? null, name: arg && arg.name });
        if (activeTerminal) activeTerminal.displayName = arg && arg.name;
      }
      return Promise.resolve();
    },
    registerCommand: (id, fn) => {
      registeredCommands.set(id, fn);
      return { dispose() { registeredCommands.delete(id); } };
    },
  },
  window: {
    get terminals() { return terminalsInWindow; },
    get activeTerminal() { return activeTerminal; },
    // Faithful to VS Code: the created terminal takes the requested name and
    // joins window.terminals. #53's idempotency guard reads both, so a mock that
    // returns a detached 'x' would let a duplicate-tab regression pass.
    createTerminal: (options) => {
      const t = makeTerminal((options && options.name) || 'x', vscodeMock._createPid);
      t.options = options;
      terminalsInWindow.push(t);
      openCbs.forEach(cb => cb(t));
      return t;
    },
    onDidCloseTerminal: (cb) => {
      closeCbs.push(cb);
      return { dispose() { closeCbs = closeCbs.filter(c => c !== cb); } };
    },
    onDidChangeTerminalShellIntegration: (cb) => {
      shellIntegrationCbs.push(cb);
      return { dispose() { shellIntegrationCbs = shellIntegrationCbs.filter(c => c !== cb); } };
    },
    onDidOpenTerminal: (cb) => {
      openCbs.push(cb);
      return { dispose() { openCbs = openCbs.filter(c => c !== cb); } };
    },
    onDidChangeWindowState: () => ({ dispose() {} }),
    // A view starts hidden, as a collapsed or unopened one does; a test makes
    // it visible with setVisible(), which fires onDidChangeVisibility.
    createTreeView: (id, options) => {
      const visibility = new EventEmitter();
      const view = {
        id, options, visible: false, dispose() {},
        onDidChangeVisibility: visibility.event,
        setVisible(v) { view.visible = v; visibility.fire({ visible: v }); },
      };
      treeViews.push(view);
      return view;
    },
    showErrorMessage: () => {},
    showInformationMessage: () => {},
  },
  workspace: {
    workspaceFolders: [],
    name: undefined,
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: (cb) => {
      configCbs.push(cb);
      return { dispose() { configCbs = configCbs.filter(c => c !== cb); } };
    },
    updateWorkspaceFolders: () => true,
    // Real vscode.workspace.getConfiguration(section).get(key, default) returns
    // `default` when nothing is configured — mirror that rather than always
    // returning undefined, or every setting read in extension.js would need a
    // per-test override just to get its documented default behavior. Tests
    // that need a configured value can set `vscodeMock._config[key] = value`.
    getConfiguration: () => ({
      get: (key, def) => (key in vscodeMock._config ? vscodeMock._config[key] : def),
    }),
  },
  _config: {},
  // The shell pid a created terminal reports. A test that wants pidAlive true
  // points it at a live process.
  _createPid: undefined,
  env: { clipboard: { writeText: t => { clipboard.text = t; return Promise.resolve(); } } },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  EventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
  Uri: { file: p => ({ fsPath: p, path: p }), parse: s => ({ uri: s, toString: () => s }) },
};

function makeTerminal(name, pid) {
  const t = {
    name,
    processId: Promise.resolve(pid ?? 4242),
    sendText: (text, submit) => t.sent.push({ text, submit }),
    shows: 0,
    show: () => {
      t.shows++;
      if (showBehavior.ignore) return;
      if (showBehavior.delayMs > 0) setTimeout(() => { activeTerminal = t; }, showBehavior.delayMs);
      else activeTerminal = t;
    },
    dispose: () => { disposed.push(name); terminalsInWindow = terminalsInWindow.filter(x => x !== t); },
    sent: [],
  };
  return t;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const ext = require(path.join(__dirname, '..', 'extension.js'));

const context = {
  extensionPath: path.join(__dirname, '..'),
  subscriptions: [],
  workspaceState: {
    get: k => state.get(k),
    update: (k, v) => { state.set(k, v); return Promise.resolve(); },
  },
};

module.exports = { ext, context, state, vscodeMock, makeTerminal, renames, showBehavior,
  get activeTerminal() { return activeTerminal; },
  addTerminal: t => { terminalsInWindow.push(t); openCbs.forEach(cb => cb(t)); return t; },
  treeViews,
  registeredCommands,
  executedCommands,
  clipboard,
  // Change a setting the way VS Code does: store it, then fire the event.
  setConfig: (key, value) => {
    vscodeMock._config[key] = value;
    configCbs.forEach(cb => cb({ affectsConfiguration: s => s === `terminalBridge.${key}` || s === 'terminalBridge' }));
  },
  // Drive the shell-integration-ready path that /open-terminal waits on.
  fireShellIntegration: terminal => shellIntegrationCbs.forEach(cb => cb({ terminal })),
  // The user closed a tab: it leaves window.terminals, then VS Code fires
  // onDidCloseTerminal. Resolves once every handler has settled.
  closeTerminal: t => {
    terminalsInWindow = terminalsInWindow.filter(x => x !== t);
    return Promise.all(closeCbs.map(cb => cb(t)));
  },
  findTerminal: name => terminalsInWindow.find(t => t.name === name),
  countTerminals: name => terminalsInWindow.filter(t => t.name === name).length,
  get disposed() { return disposed; },
  portFile: path.join(process.env.HOME, '.vscode-terminal-bridge', 'port'),
  bridgesDir: path.join(process.env.HOME, '.vscode-terminal-bridge', 'bridges'),
};
