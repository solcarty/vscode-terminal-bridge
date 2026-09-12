// #55 — presence registry: one file per live window under
// ~/.vscode-terminal-bridge/bridges/<id>.json, /announce for self-reported
// agent status, /api/bridges to read the whole network, and fail-closed
// reaping (only a confirmed-dead pid is removed, never a stale heartbeat).

const h = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
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

  let fails = 0;
  const check = (label, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
    if (!cond) fails++;
  };

  // ── A registry file is written on activation, alongside the legacy port file ──
  check('legacy ~/.vscode-terminal-bridge/port is still written', fs.existsSync(h.portFile), h.portFile);

  let files = fs.readdirSync(h.bridgesDir).filter(f => f.endsWith('.json'));
  check('exactly one bridge registry file exists', files.length === 1, files);
  let self = JSON.parse(fs.readFileSync(path.join(h.bridgesDir, files[0]), 'utf8'));
  check('registry entry carries this port', self.port === Number(port), self);
  check('registry entry carries an id', typeof self.id === 'string' && self.id.length > 0, self);
  check('registry entry carries workspaceFolders', Array.isArray(self.workspaceFolders), self);
  check('status starts unannounced', self.status === null, self);

  // ── Agent identity: workspace name fallback ──────────────────────────────
  h.vscodeMock.workspace.name = 'house.health';
  let j = JSON.parse((await get(port, '/announce?status=working')).body);
  check('announce accepts a status', j.ok === true, j);

  files = fs.readdirSync(h.bridgesDir).filter(f => f.endsWith('.json'));
  self = JSON.parse(fs.readFileSync(path.join(h.bridgesDir, files[0]), 'utf8'));
  check('agentId falls back to workspace name when no setting is configured',
    self.agentId === 'house.health', self);
  check('announce sets status', self.status === 'working', self);
  check('announce stamps statusChangedAt', typeof self.statusChangedAt === 'string', self);
  check('announce stamps lastHeartbeatAt', typeof self.lastHeartbeatAt === 'string', self);

  // A per-window setting wins over the workspace name.
  h.vscodeMock._config.agentId = 'implementer';
  await get(port, '/announce?status=working');
  self = JSON.parse(fs.readFileSync(path.join(h.bridgesDir, files[0]), 'utf8'));
  check('a configured agentId setting wins over the workspace name',
    self.agentId === 'implementer', self);

  const changedAt1 = self.statusChangedAt;
  await wait(5);
  await get(port, '/announce?status=working');
  self = JSON.parse(fs.readFileSync(path.join(h.bridgesDir, files[0]), 'utf8'));
  check('repeating the same status does not move statusChangedAt',
    self.statusChangedAt === changedAt1, { changedAt1, now: self.statusChangedAt });

  await wait(5);
  await get(port, '/announce?status=idle');
  self = JSON.parse(fs.readFileSync(path.join(h.bridgesDir, files[0]), 'utf8'));
  check('a real status change moves statusChangedAt',
    self.statusChangedAt !== changedAt1, { changedAt1, now: self.statusChangedAt });

  // ── /api/bridges reads the whole directory, self included ───────────────
  j = JSON.parse((await get(port, '/api/bridges')).body);
  check('/api/bridges reports ok + now', j.ok === true && typeof j.now === 'string', j);
  check('/api/bridges includes this window, marked self',
    j.bridges.some(b => b.id === self.id && b.self === true), j);
  check('self entry reports pidAlive: true (this process is running)',
    j.bridges.find(b => b.id === self.id).pidAlive === true, j);

  // ── A second, unrelated window's entry with a live pid is reported, not reaped ──
  const otherPath = path.join(h.bridgesDir, 'other-window.json');
  fs.writeFileSync(otherPath, JSON.stringify({
    id: 'other-window', port: 99999, pid: process.pid,
    startedAt: new Date().toISOString(), workspaceFolders: ['/tmp/other'],
    workspaceName: 'other', agentId: 'spec-author',
    status: 'idle', statusChangedAt: null, lastHeartbeatAt: null,
  }));
  j = JSON.parse((await get(port, '/api/bridges')).body);
  check('a second live window is visible from the first window\'s bridge',
    j.bridges.some(b => b.id === 'other-window'), j);
  check('two live windows both appear', j.bridges.length === 2, j);

  // ── Fail-closed reaping: only a CONFIRMED-dead pid is removed ────────────
  // A pid that will never exist on this machine (max pid range on any *nix).
  fs.writeFileSync(otherPath, JSON.stringify({
    id: 'other-window', port: 99999, pid: 999999999,
    startedAt: new Date().toISOString(), workspaceFolders: ['/tmp/other'],
    workspaceName: 'other', agentId: 'spec-author',
    status: 'idle', statusChangedAt: null, lastHeartbeatAt: null,
  }));
  j = JSON.parse((await get(port, '/api/bridges')).body);
  check('a confirmed-dead window is excluded from the response',
    !j.bridges.some(b => b.id === 'other-window'), j);
  check('a confirmed-dead window\'s file is reaped from disk',
    !fs.existsSync(otherPath), fs.readdirSync(h.bridgesDir));

  // A null pid must never be treated as dead (fail-closed: unknown, not dead).
  const noPidPath = path.join(h.bridgesDir, 'no-pid-window.json');
  fs.writeFileSync(noPidPath, JSON.stringify({
    id: 'no-pid-window', port: 88888, pid: null,
    startedAt: new Date().toISOString(), workspaceFolders: [],
    workspaceName: null, agentId: null,
    status: null, statusChangedAt: null, lastHeartbeatAt: null,
  }));
  j = JSON.parse((await get(port, '/api/bridges')).body);
  check('a null pid is reported as pidAlive: null, not reaped',
    j.bridges.find(b => b.id === 'no-pid-window')?.pidAlive === null, j);
  check('the null-pid entry\'s file is left on disk', fs.existsSync(noPidPath), noPidPath);

  console.log(fails ? `\n${fails} failing` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
