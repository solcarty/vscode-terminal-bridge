// #39 — /send-text stamps lastSendAt so a caller can tell "delivered but not
// picked up" from "picked up", without the bridge asserting a status it
// hasn't observed.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'worker':  { cwd: '/tmp/w', status: 'working', lastHeartbeatAt: '2026-08-19T10:00:00.000Z' },
  'blocked': { cwd: '/tmp/b', status: 'needs-input' },
});
h.addTerminal(h.makeTerminal('worker'));
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

  check('list exposes lastSendAt as null before any send', (await row('worker')).lastSendAt === null, await row('worker'));

  // 1. a submitted send stamps
  let r = await get(port, '/send-text?name=worker&text=hello');
  let j = JSON.parse(r.body);
  check('send returns lastSendAt', r.code === 200 && typeof j.lastSendAt === 'string', j);
  const stamped = (await row('worker')).lastSendAt;
  check('list reports the same lastSendAt', stamped === j.lastSendAt, { stamped, j });

  // 2. the comparison the issue asks for actually works
  const w = await row('worker');
  check('lastHeartbeatAt < lastSendAt → delivered, not yet picked up',
    new Date(w.lastHeartbeatAt) < new Date(w.lastSendAt), w);

  // 3. staged-but-unsent text must not stamp
  await wait(5);
  r = await get(port, '/send-text?name=worker&text=staged&submit=0');
  j = JSON.parse(r.body);
  check('send with submit=0 returns lastSendAt null', j.ok && j.submitted === false && j.lastSendAt === null, j);
  check('send with submit=0 leaves the stored stamp untouched', (await row('worker')).lastSendAt === stamped, await row('worker'));

  // 4. a refused send delivered nothing, so it must not stamp
  r = await get(port, '/send-text?name=blocked&text=hi');
  j = JSON.parse(r.body);
  check('send into needs-input → 409', r.code === 409, j);
  check('409 does not stamp lastSendAt', (await row('blocked')).lastSendAt === null, await row('blocked'));

  // 5. forced send into a prompt state does deliver, so it stamps
  r = await get(port, '/send-text?name=blocked&text=hi&force=1');
  j = JSON.parse(r.body);
  check('forced send stamps', r.code === 200 && typeof j.lastSendAt === 'string', j);

  // 6. status is untouched by a send — no optimistic transition
  check('send does not mutate status', (await row('blocked')).status === 'needs-input', await row('blocked'));

  // 7. unknown terminal
  r = await get(port, '/send-text?name=nope&text=hi');
  check('send to unknown name → 404', r.code === 404, r.body);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
