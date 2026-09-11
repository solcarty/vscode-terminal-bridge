// #59 — the worker reports from real events. A `result` event publishes its
// text via /set-output and sets idle; the agent process exiting on its own is
// an error, with the exit code and the takeover command in a note; a stop the
// caller asked for is not; an agent that never starts is.
const h = require('./harness');
const w = require('./worker-helpers');
const fs = require('fs');

const cwd = w.mkCwd();
h.state.set(w.KEY, { ex: { cwd, status: 'working' } });
h.addTerminal(h.makeTerminal('ex'));
h.ext.activate(h.context);

(async () => {
  const port = await w.bridgePort(h);
  const { check, done } = w.checker();
  const files = w.workerFiles(cwd);
  const note = async () => (await w.get(port, '/note?name=ex')).json.note || '';
  const status = async () => (await w.row(port, 'ex')).status;

  // 1. result → /set-output + idle
  const p1 = w.startWorker({ cwd, name: 'ex', port, args: ['--prompt=hello'] });
  const out = await w.waitFor(async () => (await w.outputs(port, 'ex')).includes('echo: hello [ran]'));
  check('the result event lands in /set-output', !!out, { outputs: await w.outputs(port, 'ex'), log: p1.log });
  check('status=idle after the result', !!(await w.waitFor(async () => (await status()) === 'idle')), await status());

  // 2. a requested stop is not a crash
  p1.kill('SIGTERM');
  await p1.exited;
  await w.waitFor(async () => /stopped on request/.test(await note()));
  check('a requested stop leaves a note saying so', /stopped on request/.test(await note()), await note());
  check('…and is not reported as error', (await status()) !== 'error', await status());

  // 3. the agent exiting on its own is an error, with the code in a note
  const p2 = w.startWorker({ cwd, name: 'ex', port, args: ['--prompt=EXIT 3'] });
  const exit = await p2.exited;
  check("the wrapper exits with the agent's code", exit.code === 3, { exit, log: p2.log });
  check('status=error on agent exit', !!(await w.waitFor(async () => (await status()) === 'error')), await status());
  const sid = fs.readFileSync(files.session, 'utf8').trim();
  const n = await note();
  check('the note carries the exit code', n.includes('exited with code 3'), n);
  check('the note carries the takeover command for this session', n.includes(`claude --resume ${sid}`), n);
  check('lock and inbox socket removed on exit', !fs.existsSync(files.lock) && !fs.existsSync(files.socket));
  check('the row reads as a plain terminal again', (await w.row(port, 'ex')).mode === 'terminal', await w.row(port, 'ex'));

  // 4. an agent that never starts
  const p3 = w.startWorker({ cwd, name: 'ex', port, args: ['--agent-cmd=/nonexistent/agent', '--prompt=hi'] });
  const spawnExit = await p3.exited;
  check('a missing agent executable exits 127', spawnExit.code === 127, { spawnExit, log: p3.log });
  check('…with status=error and a note naming the failure',
    (await status()) === 'error' && /failed to start agent/.test(await note()), { status: await status(), note: await note() });
  check('…and releases the lock', !fs.existsSync(files.lock));

  done();
})();
