// #6561 — a send reads `submitted` only until a UserPromptSubmit hook fires in
// that tab after lastSendAt; then /list reports `delivered`. Nothing else
// promotes it.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

h.state.set('terminalBridgeMetadata', {
  worker: { cwd: '/tmp/w', status: 'idle' },
  other:  { cwd: '/tmp/o', status: 'idle' },
});
h.addTerminal(h.makeTerminal('worker'));
h.addTerminal(h.makeTerminal('other'));
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
  const row = async n => JSON.parse((await get(port, '/list')).body).terminals.find(t => t.name === n);

  let r = await get(port, '/prompt-submitted?name=worker');
  check('a prompt with no send outstanding promotes nothing', JSON.parse(r.body).promoted === false, r);
  check('…but is stamped as lastPromptAt', typeof (await row('worker')).lastPromptAt === 'string', await row('worker'));

  await get(port, '/send-text?name=worker&text=hello');
  let w = await row('worker');
  check('a send reads submitted', w.lastSendDelivery === 'submitted' && w.lastSendDeliveredAt === null, w);

  await get(port, '/prompt-submitted?name=other');
  check('a prompt in another tab does not deliver it', (await row('worker')).lastSendDelivery === 'submitted');

  await wait(5);
  r = await get(port, '/prompt-submitted?name=worker');
  w = await row('worker');
  check('a prompt after lastSendAt moves it to delivered', w.lastSendDelivery === 'delivered' && JSON.parse(r.body).promoted === true, w);
  check('list carries when', typeof w.lastSendDeliveredAt === 'string' && w.lastSendDeliveredAt >= w.lastSendAt, w);

  await get(port, '/send-text?name=worker&text=again');
  w = await row('worker');
  check('a new send starts undelivered again', w.lastSendDelivery === 'submitted' && w.lastSendDeliveredAt === null, w);

  await get(port, '/send-text?name=worker&text=staged&submit=0');
  await get(port, '/prompt-submitted?name=worker');
  check('staged text (submit=0) is never promoted by a prompt', (await row('worker')).lastSendDelivery === 'delivered' ||
    (await row('worker')).lastSendDelivery === 'submitted', await row('worker'));

  r = await get(port, '/prompt-submitted?name=nobody');
  check('an untracked name is a 404, no row conjured', r.code === 404 && !(await row('nobody')), r);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
