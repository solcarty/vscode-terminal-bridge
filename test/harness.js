// Headless harness: loads extension.js with a mocked `vscode` module so the
// bridge's HTTP surface can be driven from plain node — no VS Code, no VSIX
// install, no window reload.
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

const vscodeMock = {
  commands: {
    // VS Code renames whichever terminal is active; applyPresentation() shows
    // the target first, so record against activeTerminal to mirror that.
    executeCommand: (cmd, arg) => {
      if (cmd === 'workbench.action.terminal.renameWithArg') {
        renames.push({ terminal: activeTerminal?.name ?? null, name: arg && arg.name });
        if (activeTerminal) activeTerminal.displayName = arg && arg.name;
      }
      return Promise.resolve();
    },
  },
  window: {
    get terminals() { return terminalsInWindow; },
    get activeTerminal() { return activeTerminal; },
    createTerminal: () => makeTerminal('x'),
    onDidCloseTerminal: () => ({ dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showErrorMessage: () => {},
  },
  workspace: {
    workspaceFolders: [],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    updateWorkspaceFolders: () => true,
    getConfiguration: () => ({ get: () => undefined }),
  },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { file: p => ({ fsPath: p, path: p }) },
};

function makeTerminal(name, pid) {
  const t = {
    name,
    processId: Promise.resolve(pid ?? 4242),
    sendText: (text, submit) => t.sent.push({ text, submit }),
    show: () => { activeTerminal = t; },
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

module.exports = { ext, context, state, vscodeMock, makeTerminal, renames,
  addTerminal: t => { terminalsInWindow.push(t); return t; },
  get disposed() { return disposed; },
  portFile: path.join(process.env.HOME, '.vscode-terminal-bridge', 'port'),
};
