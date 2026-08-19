// #40 — background work is its own dimension, so an agent waiting on a job it
// started is distinguishable from one waiting on a human.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'worker': { cwd: '/tmp/w', status: 'working', baseLabel: 'worker', label: 'worker' },
  'badge':  { cwd: '/tmp/b', status: 'idle', baseLabel: 'badge', label: 'badge' },
});
h.addTerminal(h.makeTerminal('worker'));
h.addTerminal(h.makeTerminal('badge'));

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
  const row = async name =>
    JSON.parse((await get(port, '/list')).body).terminals.find(t => t.name === name);

  check('list defaults: no pending work', (await row('worker')).pendingTasks === 0 && (await row('worker')).bgTask === false, await row('worker'));

  // ── The exact sequence from the issue ────────────────────────────────────
  // TaskCreated → bg work outstanding; Stop → turn ends; the tab must NOT
  // report needs-input, and must not lose the fact that a job is in flight.
  await get(port, '/bg-task?name=worker&op=start');
  let r = await row('worker');
  check('bg-task start sets pendingTasks + bgTaskStartedAt', r.pendingTasks === 1 && r.bgTask === true && typeof r.bgTaskStartedAt === 'string', r);
  check('bg-task start does not touch status', r.status === 'working', r);

  await get(port, '/rename-terminal?name=worker&status=idle');
  r = await row('worker');
  check('turn ending does not erase outstanding work', r.pendingTasks === 1 && r.bgTask === true, r);
  check('turn state is recorded as idle', r.status === 'idle', r);
  check('tab renders bg-task, not idle', r.displayStatus === 'bg-task', r);

  // ── The both-at-once case a single scalar cannot express ─────────────────
  await get(port, '/rename-terminal?name=worker&status=needs-input');
  r = await row('worker');
  check('blocked-on-human AND task-running is representable', r.status === 'needs-input' && r.bgTask === true, r);
  check('a human being required outranks bg work in the tab', r.displayStatus === 'needs-input', r);

  // ── Completion returns the tab to its turn state ─────────────────────────
  await get(port, '/rename-terminal?name=worker&status=idle');
  await get(port, '/bg-task?name=worker&op=end');
  r = await row('worker');
  check('bg-task end clears the count', r.pendingTasks === 0 && r.bgTask === false, r);
  check('bgTaskStartedAt cleared with the work', r.bgTaskStartedAt === null, r);
  check('tab falls back to the turn state', r.displayStatus === 'idle', r);

  // ── Counting, and the floor ──────────────────────────────────────────────
  await get(port, '/bg-task?name=worker&op=start');
  await get(port, '/bg-task?name=worker&op=start');
  check('concurrent tasks count', (await row('worker')).pendingTasks === 2, await row('worker'));
  await get(port, '/bg-task?name=worker&op=end');
  check('one end leaves the other outstanding', (await row('worker')).bgTask === true, await row('worker'));
  await get(port, '/bg-task?name=worker&op=end');
  await get(port, '/bg-task?name=worker&op=end');
  check('end never counts below zero', (await row('worker')).pendingTasks === 0, await row('worker'));

  await get(port, '/bg-task?name=worker&op=start');
  await get(port, '/bg-task?name=worker&op=clear');
  check('clear resets the count', (await row('worker')).pendingTasks === 0, await row('worker'));

  // ── Legacy hook wiring keeps working ─────────────────────────────────────
  // status=bg-task routes into the new dimension without clobbering turn state.
  await get(port, '/rename-terminal?name=worker&status=working');
  await get(port, '/rename-terminal?name=worker&status=bg-task');
  r = await row('worker');
  check('legacy status=bg-task routes to the bg dimension', r.pendingTasks === 1 && r.bgTask === true, r);
  check('legacy status=bg-task leaves turn state alone', r.status === 'working', r);
  await get(port, '/rename-terminal?name=worker&status=task-done');
  r = await row('worker');
  check('legacy status=task-done decrements when work is outstanding', r.pendingTasks === 0, r);
  check('...and still leaves turn state alone', r.status === 'working', r);

  // task-done as a manual completion badge on a tab with nothing outstanding
  // must keep behaving as a status.
  await get(port, '/rename-terminal?name=badge&status=task-done');
  r = await row('badge');
  check('task-done with no pending work is still a status badge', r.status === 'task-done' && r.displayStatus === 'task-done', r);

  // ── Unknown / missing target ─────────────────────────────────────────────
  r = await get(port, '/bg-task?name=nope&op=start');
  check('bg-task on unknown name → 404', r.code === 404, r.body);
  r = await get(port, '/bg-task?name=worker&op=bogus');
  check('unknown op → 400', r.code === 400, r.body);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
