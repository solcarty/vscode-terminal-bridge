// #32 — read-back. An orchestrator retrieves what a worker last said, pushed
// in by the worker's own Stop hook, without a human relaying it.
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// NB: must be async, never spawnSync. The bridge under test runs in THIS
// process, so a synchronous child blocks the event loop that would answer its
// request — the CLI's curl times out and the hook silently no-ops.
const runCli = (args, input, env) => new Promise(resolve => {
  const c = spawn('bash', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', d => out += d);
  c.stderr.on('data', d => err += d);
  c.on('close', status => resolve({ status, stdout: out, stderr: err }));
  c.stdin.end(input);
});

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'worker': { cwd: '/tmp/w', status: 'working', baseLabel: 'worker', label: 'worker' },
  'silent': { cwd: '/tmp/s', status: 'idle', baseLabel: 'silent', label: 'silent' },
});
h.addTerminal(h.makeTerminal('worker'));
h.addTerminal(h.makeTerminal('silent'));

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
  const list = async () => JSON.parse((await get(port, '/list')).body).terminals;
  const row = async name => (await list()).find(t => t.name === name);

  // ── degrades safely: nothing to report is empty, not an error ────────────
  let r = await get(port, '/output?name=silent');
  let j = JSON.parse(r.body);
  check('terminal with nothing to report → 200 empty', r.code === 200 && j.ok === true && j.outputs.length === 0, j);
  check('...and a null lastOutputAt', j.lastOutputAt === null, j);

  // ── the acceptance criterion: retrieve the last assistant output ─────────
  const msg = 'Root cause: the retry used activePort+1, which never advances.\nWant me to fix it here or split it?';
  await get(port, `/set-output?name=worker&text=${encodeURIComponent(msg)}`);
  j = JSON.parse((await get(port, '/output?name=worker')).body);
  check('output round-trips verbatim', j.outputs[0].text === msg, j);
  check('output carries its own timestamp', typeof j.outputs[0].at === 'string', j);

  // ── bounded, not an unbounded buffer dump ────────────────────────────────
  for (const t of ['msg-2', 'msg-3', 'msg-4']) {
    await get(port, `/set-output?name=worker&text=${encodeURIComponent(t)}`);
  }
  j = JSON.parse((await get(port, '/output?name=worker&n=99')).body);
  check('ring keeps at most maxEntries', j.outputs.length === 3 && j.available === 3, j);
  check('oldest entries are evicted', j.outputs.map(o => o.text).join(',') === 'msg-2,msg-3,msg-4', j);
  j = JSON.parse((await get(port, '/output?name=worker')).body);
  check('n defaults to the most recent message only', j.outputs.length === 1 && j.outputs[0].text === 'msg-4', j);
  j = JSON.parse((await get(port, '/output?name=worker&n=2')).body);
  check('n= asks for fewer', j.outputs.length === 2 && j.outputs[0].text === 'msg-3', j);

  // ── long messages keep the TAIL (the conclusion is what's being asked) ───
  const long = 'HEAD-MARKER' + 'x'.repeat(9000) + 'TAIL-MARKER';
  j = JSON.parse((await get(port, `/set-output?name=worker&text=${encodeURIComponent(long)}`)).body);
  check('oversized output reports truncated', j.truncated === true && j.bytes === 4096, j);
  j = JSON.parse((await get(port, '/output?name=worker')).body);
  check('truncation keeps the tail, drops the head',
    j.outputs[0].text.endsWith('TAIL-MARKER') && !j.outputs[0].text.includes('HEAD-MARKER'), j.outputs[0].text.slice(0, 20));
  await get(port, `/set-output?name=worker&text=${encodeURIComponent('é'.repeat(4000))}`);
  j = JSON.parse((await get(port, '/output?name=worker')).body);
  check('truncation lands on a character boundary', !j.outputs[0].text.includes('�'), j.outputs[0].text.slice(0, 4));

  // ── an empty turn is not a failure ───────────────────────────────────────
  r = await get(port, '/set-output?name=worker&text=%20%0A');
  j = JSON.parse(r.body);
  check('whitespace-only turn is stored:false, not an error', r.code === 200 && j.stored === false, j);

  // ── /list carries the timestamp, never the bodies ────────────────────────
  const listed = await row('worker');
  check('list exposes lastOutputAt + outputCount', typeof listed.lastOutputAt === 'string' && listed.outputCount === 3, listed);
  check('list does NOT inline output bodies', !('outputs' in listed), listed);
  check('list body never contains message text',
    !JSON.stringify(await list()).includes('TAIL-MARKER'), 'output text leaked into /list');

  // ── the hook path end-to-end, through the real CLI ───────────────────────
  // This is what a Stop hook actually does: a payload on stdin, and the field
  // the docs say to use instead of tailing the transcript.
  const ctl = path.join(__dirname, '..', 'bin', 'bridgectl.sh');
  await get(port, '/clear-output?name=worker');
  const payload = JSON.stringify({
    session_id: 'abc', hook_event_name: 'Stop',
    transcript_path: '/nonexistent/transcript.jsonl',
    last_assistant_message: 'Shipped: pr=45 sha=deadbee. Needs a decision on the schema bump.',
  });
  let cli = await runCli([ctl, 'hook-output', '--name=worker'], payload,
    { ...process.env, VSCODE_BRIDGE_PORT: port });
  check('hook-output exits 0', cli.status === 0, cli.stderr);
  j = JSON.parse((await get(port, '/output?name=worker')).body);
  check('hook-output published last_assistant_message',
    j.outputs[0] && j.outputs[0].text.includes('pr=45'), j);
  check('hook-output did NOT read the (nonexistent) transcript path',
    !JSON.stringify(j).includes('transcript'), j);

  // a Stop with nothing said, and a malformed payload, must both be no-ops
  const before = JSON.parse((await get(port, '/output?name=worker')).body).lastOutputAt;
  for (const [label, input] of [['empty message', JSON.stringify({ last_assistant_message: '' })],
                                ['missing field', JSON.stringify({ hook_event_name: 'Stop' })],
                                ['malformed json', 'not json at all']]) {
    cli = await runCli([ctl, 'hook-output', '--name=worker'], input,
      { ...process.env, VSCODE_BRIDGE_PORT: port });
    const after = JSON.parse((await get(port, '/output?name=worker')).body).lastOutputAt;
    check(`hook-output no-ops on ${label}`, cli.status === 0 && after === before, { status: cli.status, stderr: cli.stderr });
  }

  // ── clear + unknown target ───────────────────────────────────────────────
  r = await get(port, '/clear-output?name=worker');
  check('clear-output → 200', r.code === 200, r.body);
  j = JSON.parse((await get(port, '/output?name=worker')).body);
  check('cleared output reads empty', j.outputs.length === 0 && j.lastOutputAt === null, j);
  check('cleared output clears the list timestamp', (await row('worker')).lastOutputAt === null, await row('worker'));

  r = await get(port, '/output?name=nope');
  check('output on unknown name → 404', r.code === 404, r.body);
  r = await get(port, '/set-output?name=nope&text=hi');
  check('set-output on unknown name → 404', r.code === 404, r.body);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
