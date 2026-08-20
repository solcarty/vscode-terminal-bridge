// #48 — a multi-line send to a busy target can leave its payload parked in the
// input box as a `[Pasted text #N]` placeholder that nothing ever consumes.
// The bridge can't see the input widget, so it stops claiming `submitted:true`
// on that path (it reports `delivery`), separates the Enter from the paste to
// give the placeholder time to register, and exposes /nudge-terminal as the
// caller-driven way to release a stranded message.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'worker':  { cwd: '/tmp/w', status: 'working', lastHeartbeatAt: '2026-08-19T10:00:00.000Z' },
  'blocked': { cwd: '/tmp/b', status: 'needs-input' },
});
const worker  = h.addTerminal(h.makeTerminal('worker'));
h.addTerminal(h.makeTerminal('blocked'));

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

  // 1. the direct path is the one a caller may trust
  let j = JSON.parse((await get(port, '/send-text?name=worker&text=hello')).body);
  check('single-line send reports delivery=submitted', j.delivery === 'submitted' && j.mode === 'literal', j);
  check('single-line send takes no submit delay', j.submitDelayMs === 0, j);
  check('list carries the delivery outcome', (await row('worker')).lastSendDelivery === 'submitted', await row('worker'));

  // 2. the paste path cannot be verified, and must not claim it was
  worker.sent.length = 0;
  const t0 = Date.now();
  j = JSON.parse((await get(port, '/send-text?name=worker&text=' + encodeURIComponent('one\ntwo\nthree'))).body);
  const elapsed = Date.now() - t0;
  check('multi-line send reports delivery=submit-unverified', j.delivery === 'submit-unverified' && j.mode === 'paste', j);
  check('multi-line send still reports submitted for old callers', j.submitted === true, j);
  check('paste defaults to a 250ms submit delay', j.submitDelayMs === 250, j);
  check('the Enter really is separated from the paste in time', elapsed >= 240, { elapsed });
  check('paste then a separate submit write', worker.sent.length === 2 && worker.sent[1].submit === true, worker.sent);
  check('list carries submit-unverified', (await row('worker')).lastSendDelivery === 'submit-unverified', await row('worker'));

  // 3. the stranded-message signature the issue asks an orchestrator to see
  const w = await row('worker');
  check('submit-unverified + heartbeat older than lastSendAt is visible in one /list read',
    w.lastSendDelivery === 'submit-unverified' && new Date(w.lastHeartbeatAt) < new Date(w.lastSendAt), w);

  // 4. submitDelayMs is overridable (an orchestrator that wants it slower/faster)
  j = JSON.parse((await get(port, '/send-text?name=worker&text=' + encodeURIComponent('a\nb') + '&submitDelayMs=0')).body);
  check('submitDelayMs=0 is honoured', j.submitDelayMs === 0, j);
  let r = await get(port, '/send-text?name=worker&text=hi&submitDelayMs=abc');
  check('non-numeric submitDelayMs → 400', r.code === 400, r.body);

  // 5. staged text is named as such rather than reported as a submit
  j = JSON.parse((await get(port, '/send-text?name=worker&text=parked&submit=0')).body);
  check('submit=0 reports delivery=staged', j.delivery === 'staged' && j.lastSendAt === null, j);
  check('staging does not overwrite the stored delivery',
    (await row('worker')).lastSendDelivery === 'submit-unverified', await row('worker'));

  // 6. nudge — the release keystroke
  worker.sent.length = 0;
  const beforeNudge = (await row('worker')).lastSendAt;
  await wait(5);
  r = await get(port, '/nudge-terminal?name=worker');
  j = JSON.parse(r.body);
  check('nudge → 200 with delivery=nudge', r.code === 200 && j.delivery === 'nudge', j);
  check('nudge writes a bare Enter and nothing else',
    worker.sent.length === 1 && worker.sent[0].text === '' && worker.sent[0].submit === true, worker.sent);
  const afterNudge = await row('worker');
  check('nudge re-stamps lastSendAt', afterNudge.lastSendAt !== beforeNudge, { beforeNudge, afterNudge });
  check('list reports lastSendDelivery=nudge', afterNudge.lastSendDelivery === 'nudge', afterNudge);
  check('nudge does not mutate status', afterNudge.status === 'working', afterNudge);

  // 7. a bare Enter at a menu picks the highlighted option — same refusal as send
  r = await get(port, '/nudge-terminal?name=blocked');
  check('nudge into needs-input → 409', r.code === 409, r.body);
  check('refused nudge does not stamp', (await row('blocked')).lastSendAt === null, await row('blocked'));
  r = await get(port, '/nudge-terminal?name=blocked&force=1');
  check('forced nudge into a prompt state is allowed', r.code === 200, r.body);

  // 8. unknown name
  r = await get(port, '/nudge-terminal?name=nope');
  check('nudge to unknown name → 404', r.code === 404, r.body);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
