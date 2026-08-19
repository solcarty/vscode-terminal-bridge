const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'stale-row':  { cwd: '/tmp/gone', status: 'needs-input', createdAt: '2026-08-16T12:29:41.906Z' },
  'dead-pid':   { cwd: '/tmp/gone', status: 'working', pid: 999999 },
  'live-tab':   { cwd: '/tmp/live', status: 'working' },
});
const live = h.makeTerminal('live-tab');
h.addTerminal(live);

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
  console.log('harness bridge on port', port);
  const names = () => get(port, '/list').then(r => JSON.parse(r.body).terminals.map(t => t.name).sort());

  let fails = 0;
  const check = (label, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
    if (!cond) fails++;
  };

  console.log('rows at start:', await names());

  // 1. close on a row whose terminal + process are both gone
  let r = await get(port, '/close-terminal?name=stale-row');
  let j = JSON.parse(r.body);
  check('close(stale) → 200 row-removed', r.code === 200 && j.ok && j.outcome === 'row-removed', j);
  check('close(stale) drops the registry row', !(await names()).includes('stale-row'), await names());

  // 2. close on a row with a persisted but dead PID
  r = await get(port, '/close-terminal?name=dead-pid');
  j = JSON.parse(r.body);
  check('close(dead pid) → row-removed, not silent success', j.outcome === 'row-removed', j);
  check('close(dead pid) drops the row', !(await names()).includes('dead-pid'), await names());

  // 3. close on a name that was never tracked
  r = await get(port, '/close-terminal?name=never-existed');
  j = JSON.parse(r.body);
  check('close(unknown) → 404 not-tracked', r.code === 404 && j.outcome === 'not-tracked', j);

  // 4. close on a live terminal still disposes it
  r = await get(port, '/close-terminal?name=live-tab');
  j = JSON.parse(r.body);
  check('close(live) → closed/dispose', j.outcome === 'closed' && j.method === 'dispose', j);
  check('close(live) disposed the terminal object', h.disposed.includes('live-tab'), h.disposed);
  check('close(live) drops the row', !(await names()).includes('live-tab'), await names());

  // 5. forget: registry-only
  h.state.set(KEY, { ...h.state.get(KEY), 'forget-me': { cwd: '/tmp/x', status: 'idle', pid: process.pid } });
  r = await get(port, '/forget-terminal?name=forget-me');
  j = JSON.parse(r.body);
  check('forget → row-removed', r.code === 200 && j.outcome === 'row-removed', j);
  check('forget did not kill the pid (this process is alive)', true);
  check('forget drops the row', !(await names()).includes('forget-me'), await names());

  r = await get(port, '/forget-terminal?name=never-existed');
  j = JSON.parse(r.body);
  check('forget(unknown) → 404 not-tracked', r.code === 404 && j.outcome === 'not-tracked', j);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
