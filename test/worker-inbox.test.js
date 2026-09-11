// #59 — a headless worker's inbox. /send-text routes to it instead of typing
// into the tab, a message sent mid-turn is delivered (queued in the agent's
// own input) rather than refused or stranded, each `result` event lands in
// /set-output, and a terminal without a worker keeps today's paste path.
const h = require('./harness');
const w = require('./worker-helpers');
const fs = require('fs');
const path = require('path');

const cwd = w.mkCwd();
h.state.set(w.KEY, {
  hw:  { cwd, status: 'idle' },
  tui: { cwd: path.join(cwd, 'not-a-worker'), status: 'working' },
});
h.addTerminal(h.makeTerminal('hw'));
h.addTerminal(h.makeTerminal('tui'));
h.ext.activate(h.context);

(async () => {
  const port = await w.bridgePort(h);
  const { check, done } = w.checker();
  const files = w.workerFiles(cwd);
  const argvFile = path.join(cwd, 'agent-argv.json');

  const proc = w.startWorker({ cwd, name: 'hw', port, args: ['--permission-mode=auto', '--model=m1'],
    env: { FAKE_AGENT_TURN_MS: '800', FAKE_AGENT_ARGV_FILE: argvFile } });

  const up = await w.waitFor(async () => (await w.row(port, 'hw')).mode === 'headless');
  check('list reports mode=headless once the worker holds its lock', !!up, { row: await w.row(port, 'hw'), log: proc.log });
  check('a terminal with no worker reports mode=terminal', (await w.row(port, 'tui')).mode === 'terminal', await w.row(port, 'tui'));

  // 1. session id persisted and handed to the agent
  const sid = fs.readFileSync(files.session, 'utf8').trim();
  check('session id persisted to .bridge-worker/session', /^[0-9a-f-]{36}$/.test(sid), sid);
  check('list row carries the sessionId', (await w.row(port, 'hw')).sessionId === sid, await w.row(port, 'hw'));
  await w.waitFor(() => fs.existsSync(argvFile));
  const spawned = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const arg = flag => spawned.argv[spawned.argv.indexOf(flag) + 1];
  check('agent spawned with the persisted --session-id', arg('--session-id') === sid, spawned.argv);
  check('agent spawned with stream-json in and out', arg('--input-format') === 'stream-json' && arg('--output-format') === 'stream-json', spawned.argv);
  check('agent spawned with --permission-prompt-tool stdio', arg('--permission-prompt-tool') === 'stdio', spawned.argv);
  check('--permission-mode and --model pass through', arg('--permission-mode') === 'auto' && arg('--model') === 'm1', spawned.argv);
  check('agent env marks it as a bridge worker, so its hooks stand down', spawned.env.VSCODE_BRIDGE_WORKER === '1', spawned.env);
  check('.bridge-worker/ ignores itself', fs.readFileSync(path.join(cwd, '.bridge-worker', '.gitignore'), 'utf8').trim() === '*');

  // 2. a send to an idle worker
  let r = await w.send(port, 'hw', 'first');
  check('send routes to the inbox (delivery=inbox)', r.code === 200 && r.json.delivery === 'inbox' && r.json.mode === 'inbox', r.json);
  check('a send to an idle agent is not queued', r.json.queued === false, r.json);
  const working = await w.waitFor(async () => (await w.row(port, 'hw')).status === 'working');
  check('status=working comes from the event stream', !!working, await w.row(port, 'hw'));

  // 3. a send while busy — the case the paste path strands (#48)
  r = await w.send(port, 'hw', 'second\nline two');
  check('a send while busy is still delivered to the inbox', r.code === 200 && r.json.delivery === 'inbox', r.json);
  check('…and reported as queued behind the running turn', r.json.queued === true, r.json);
  check('nothing was typed into the tab', h.findTerminal('hw').sent.length === 0, h.findTerminal('hw').sent);
  check('list stamps lastSendDelivery=inbox', (await w.row(port, 'hw')).lastSendDelivery === 'inbox', await w.row(port, 'hw'));
  r = await w.send(port, 'hw', 'staged', '&submit=0');
  check('submit=0 is refused for a headless worker (nothing to stage into)', r.code === 400, r.json);

  // 4. every result reaches /set-output, multi-line payload intact
  const outs = await w.waitFor(async () => {
    const o = await w.outputs(port, 'hw');
    return o.length >= 2 ? o : null;
  }, 10000);
  check('result of the first message lands in /set-output', !!outs && outs.includes('echo: first [ran]'), outs);
  check('the queued message ran next, newlines intact', !!outs && outs.includes('echo: second\nline two [ran]'), outs);
  const idle = await w.waitFor(async () => (await w.row(port, 'hw')).status === 'idle');
  check('status=idle after the last result', !!idle, await w.row(port, 'hw'));
  check('events stamp the heartbeat', !!(await w.row(port, 'hw')).lastHeartbeatAt, await w.row(port, 'hw'));

  // 5. nudge has nothing to release on a headless worker
  r = await w.get(port, '/nudge-terminal?name=hw');
  check('nudge is refused on a headless worker, not reported as delivered', r.code === 400 && r.json.mode === 'headless', r.json);

  // 6. a non-worker terminal is untouched: today's paste path
  r = await w.send(port, 'tui', 'hello tui');
  check('send to a plain terminal keeps the typed path', r.code === 200 && r.json.delivery === 'submitted', r.json);
  check('…and the text reached that terminal', h.findTerminal('tui').sent.some(s => s.text === 'hello tui'), h.findTerminal('tui').sent);

  // 7. stopping the wrapper releases the cwd
  proc.kill('SIGTERM');
  const exit = await proc.exited;
  check('wrapper exits after a requested stop', exit.code !== null || exit.signal !== null, exit);
  check('lock and inbox socket removed on stop', !fs.existsSync(files.lock) && !fs.existsSync(files.socket));
  check('the row reads as a plain terminal again', (await w.row(port, 'hw')).mode === 'terminal', await w.row(port, 'hw'));

  done();
})();
