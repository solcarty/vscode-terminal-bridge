// #90 — the empty-worktree-map path stays fail-closed: when no repo can be
// read, a dead row in a removed directory is NOT swept, because "no worktrees"
// there means "could not tell", not "none exist".
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sweep-fc-')));
const deadPid = spawnSync('true').pid;
h.vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: root } }];   // exists, not a repo

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, { gone: { cwd: path.join(root, 'removed'), status: 'idle', pid: deadPid } });
h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
  });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    try { port = fs.readFileSync(h.portFile, 'utf8').trim(); } catch { /* not up yet */ }
  }
  if (!port) { console.log('FAIL  bridge never wrote a port file'); process.exit(1); }
  const real = await get(port, '/sweep');
  const ok = real.closed.length === 0 && !!h.state.get(KEY).gone;
  console.log(`${ok ? 'PASS' : 'FAIL'}  no readable repo: sweep closes nothing`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
