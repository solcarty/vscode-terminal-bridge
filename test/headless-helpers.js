// Runs a real headless bridge (headless.js) for a test: its own tmux socket,
// the test's throwaway $HOME, and the test's port range.
//
// Without tmux there is nothing to run against. Locally that skips the file;
// in CI (CI=true) it fails, so the tmux contract can't quietly stop running.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const wait = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const SOCKET = `bridge-test-${process.pid}`;
const PORT_FILE = path.join(process.env.HOME, '.vscode-terminal-bridge', 'port');

function requireTmux() {
  if (spawnSync('tmux', ['-V']).status === 0) return;
  if (process.env.CI) { console.log('FAIL  tmux is not installed; the tmux backend cannot be tested'); process.exit(1); }
  console.log('SKIP  tmux is not installed');
  process.exit(0);
}

function tmux(...args) {
  return spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
}

// Starts headless.js and resolves once it has written its port file.
async function startHeadless({ folders = [], env = {} } = {}) {
  try { fs.unlinkSync(PORT_FILE); } catch { /* none yet */ }
  const child = spawn(process.execPath, [path.join(ROOT, 'headless.js'), '--socket', SOCKET,
    ...folders.flatMap(f => ['--folder', f])], {
    env: { ...process.env, VSCODE_BRIDGE_TMUX_POLL_MS: '300', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    try { port = fs.readFileSync(PORT_FILE, 'utf8').trim() || null; } catch { /* not up yet */ }
  }
  if (!port) {
    child.kill('SIGKILL');
    throw new Error(`headless bridge never wrote a port file:\n${log}`);
  }
  return {
    port,
    child,
    get log() { return log; },
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }),
  };
}

function killTmuxServer() { tmux('kill-server'); }

module.exports = { requireTmux, startHeadless, killTmuxServer, tmux, SOCKET, ROOT, wait };
