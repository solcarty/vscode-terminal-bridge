// #59 — one worker per cwd. Two writers on one agent session interrupt each
// other's tool calls, and two agents in one worktree is the #53 double-agent
// shape; the lock closes both at the source instead of trusting the caller.
// A lock left by a wrapper that died without cleaning up must not wedge the
// cwd forever.
const h = require('./harness');
const w = require('./worker-helpers');
const fs = require('fs');

const cwd = w.mkCwd();
h.state.set(w.KEY, { lk: { cwd, status: 'idle' } });
h.addTerminal(h.makeTerminal('lk'));
h.ext.activate(h.context);

(async () => {
  const port = await w.bridgePort(h);
  const { check, done } = w.checker();
  const files = w.workerFiles(cwd);

  const a = w.startWorker({ cwd, name: 'lk', port });
  await w.waitFor(async () => (await w.row(port, 'lk')).mode === 'headless');
  const sid = fs.readFileSync(files.session, 'utf8');

  // 1. a second worker in the same cwd refuses
  const b = w.startWorker({ cwd, name: 'lk-2', port });
  const bExit = await b.exited;
  check('a second worker in the same cwd exits 3', bExit.code === 3, { bExit, log: b.log });
  check('the refusal names the running worker', /already running/.test(b.log) && b.log.includes(String(a.pid)), b.log);
  check('the refused worker left the running session id alone', fs.readFileSync(files.session, 'utf8') === sid);
  const r = await w.send(port, 'lk', 'still there?');
  check('the first worker is still serving its inbox', r.code === 200 && r.json.delivery === 'inbox', r.json);

  // 2. a wrapper killed outright leaves a lock whose pid is dead
  a.kill('SIGKILL');
  await a.exited;
  check('a SIGKILLed wrapper leaves its lock file behind', fs.existsSync(files.lock));
  check('a lock with a dead pid reads as a plain terminal', (await w.row(port, 'lk')).mode === 'terminal', await w.row(port, 'lk'));
  const fallback = await w.send(port, 'lk', 'typed');
  check('…so send falls back to the typed path', fallback.code === 200 && fallback.json.delivery === 'submitted', fallback.json);

  // 3. the next worker takes the stale lock over
  const c = w.startWorker({ cwd, name: 'lk', port });
  const taken = await w.waitFor(async () => (await w.row(port, 'lk')).mode === 'headless');
  check('a stale lock is taken over by the next worker', !!taken, { row: await w.row(port, 'lk'), log: c.log });
  check('the lock now names the new wrapper', JSON.parse(fs.readFileSync(files.lock, 'utf8')).pid === c.pid);

  c.kill('SIGTERM');
  await c.exited;
  check('lock released on a clean stop', !fs.existsSync(files.lock));

  done();
})();
