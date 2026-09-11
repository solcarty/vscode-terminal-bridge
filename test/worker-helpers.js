// Shared plumbing for the headless-worker tests (#59). Not a test itself —
// test/run.js only runs *.test.js.
//
// The wrapper is spawned asynchronously against test/fixtures/fake-agent.js,
// for the reason harness.js gives: the bridge under test answers HTTP from
// this same process, so a blocking spawn would starve it.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WORKER = path.join(__dirname, '..', 'bin', 'bridge-worker.js');
const BRIDGECTL = path.join(__dirname, '..', 'bin', 'bridgectl.sh');
const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-agent.js');
const KEY = 'terminalBridgeMetadata';

const wait = ms => new Promise(r => setTimeout(r, ms));

const get = (port, p) => new Promise(resolve => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch { /* leave null */ }
      resolve({ code: r.statusCode, body, json });
    });
  });
});

async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(40);
  }
}

async function bridgePort(h) {
  const port = await waitFor(() => {
    try { return fs.readFileSync(h.portFile, 'utf8').trim(); } catch { return null; }
  }, 10000);
  if (!port) { console.log('FAIL  bridge never wrote a port file'); process.exit(1); }
  return port;
}

// A short base on purpose: the inbox is a unix socket, and socket paths are
// capped near 104 bytes.
const mkCwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bw-'));

function startWorker({ cwd, name, port, args = [], env = {} }) {
  const proc = spawn(process.execPath,
    [WORKER, `--agent-cmd=${FAKE_AGENT}`, ...(name ? [`--name=${name}`] : []), ...args],
    { cwd, env: { ...process.env, VSCODE_BRIDGE_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.log = '';
  proc.stdout.on('data', c => { proc.log += c; });
  proc.stderr.on('data', c => { proc.log += c; });
  proc.exited = new Promise(resolve => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return proc;
}

// Run the bundled CLI asynchronously (see the note at the top).
function bridgectl(port, args) {
  return new Promise(resolve => {
    const p = spawn('bash', [BRIDGECTL, ...args], { env: { ...process.env, VSCODE_BRIDGE_PORT: String(port) } });
    let out = '';
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { out += c; });
    p.on('exit', code => resolve({ code, out }));
  });
}

const row = async (port, name) => (await get(port, '/list')).json.terminals.find(t => t.name === name);
const outputs = async (port, name) =>
  ((await get(port, `/output?name=${encodeURIComponent(name)}&n=3`)).json.outputs || []).map(o => o.text);
const send = (port, name, text, extra = '') =>
  get(port, `/send-text?name=${encodeURIComponent(name)}&text=${encodeURIComponent(text)}${extra}`);
const workerFiles = cwd => ({
  lock: path.join(cwd, '.bridge-worker', 'lock'),
  socket: path.join(cwd, '.bridge-worker', 'inbox.sock'),
  session: path.join(cwd, '.bridge-worker', 'session'),
});

function checker() {
  let fails = 0;
  return {
    check(label, cond, got) {
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
      if (!cond) fails++;
    },
    done() {
      console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
      process.exit(fails ? 1 : 0);
    },
  };
}

module.exports = {
  KEY, BRIDGECTL, wait, get, waitFor, bridgePort, mkCwd, startWorker, bridgectl,
  row, outputs, send, workerFiles, checker,
};
