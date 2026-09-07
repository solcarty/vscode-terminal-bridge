// #54 — `pidAlive` must not assert death it cannot back.
//
// The pid persisted at creation can be a transient child captured before the
// shell settled. Once that pid exits, `pidAlive` reported false forever for a
// terminal whose shell and agent were both healthy — a false positive for a
// crash, whose documented reaction is to relaunch the agent and thereby run two
// on one worktree.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  // Tracked, and the persisted pid is wrong: it should be re-resolved on read.
  'stale-pid':    { cwd: '/tmp/a', status: 'working', pid: 999999 },
  // Tracked, but processId never settles: unknown, not dead.
  'unresolvable': { cwd: '/tmp/b', status: 'working', pid: 999998 },
  // No terminal object at all — an ordinary stale row, behaviour unchanged.
  'orphan-row':   { cwd: '/tmp/c', status: 'working', pid: 999997 },
});

h.addTerminal(h.makeTerminal('stale-pid', process.pid));

const hanging = {
  name: 'unresolvable',
  processId: new Promise(() => {}),   // never settles
  sendText: () => {},
  show: () => {},
  dispose: () => {},
  sent: [],
};
h.addTerminal(hanging);

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

  await get(port, '/reindex');
  const rows = JSON.parse((await get(port, '/list')).body).terminals;
  const row = n => rows.find(t => t.name === n);

  const stale = row('stale-pid');
  check('tracked terminal re-resolves its own shell pid',
    stale && stale.pid === process.pid, stale);
  check('a live terminal is not reported dead because its recorded pid was wrong',
    stale && stale.pidAlive === true, stale);

  const persisted = h.state.get(KEY)['stale-pid'];
  check('the corrected pid is persisted, so cleanup does not aim at the wrong process',
    persisted && persisted.pid === process.pid, persisted);

  const unres = row('unresolvable');
  check('an unresolvable pid on a tracked terminal is null (unknown), never false',
    unres && unres.pidAlive === null, unres);

  const orphan = row('orphan-row');
  check('an untracked row with a dead pid still reports false',
    orphan && orphan.pidAlive === false, orphan);

  console.log(fails ? `\n${fails} failing` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
