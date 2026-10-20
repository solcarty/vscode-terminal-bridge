// #98 — waiting / blocked / needs-you / stopped. needs-input is a deprecated
// alias of needs-you; send is refused only at needs-you and permission.
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KEY = 'terminalBridgeMetadata';
const NAMES = ['t1', 't2', 't3', 't4'];
h.state.set(KEY, Object.fromEntries(NAMES.map(n => [n, { cwd: '/tmp/' + n, status: 'working' }])));
for (const n of NAMES) h.addTerminal(h.makeTerminal(n));
h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
  });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

const SH = path.join(__dirname, '..', 'bin', 'vscode-bridge.sh');
const hook = (state, payload, pending) => {
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(SH)}
     bridge_status() { echo "STATE:$2:$3"; }
     curl() { echo '{"ok":true,"note":"x","noteUpdatedAt":"2999-01-01T00:00:00.000Z","pendingTasks":${pending}}'; }
     printf '%s' "$P" | bridge_hook_status ${state} --name=sstest`,
  ], { encoding: 'utf8', env: { ...process.env, P: payload } });
  return (r.stdout.match(/STATE:([^:\s]+)/) || [])[1] ?? `<none ${r.stdout}${r.stderr}>`;
};

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

  // alias is stored under the new name
  await get(port, '/rename-terminal?name=t1&status=needs-input&source=notification');
  check('needs-input is stored as needs-you', (await row('t1')).status === 'needs-you', await row('t1'));

  // send guard
  const send = async (n, st, src) => {
    await get(port, `/rename-terminal?name=${n}&status=${st}${src ? '&source=' + src : ''}`);
    return (await get(port, `/send-text?name=${n}&text=x`)).code;
  };
  check('send refused at needs-you', (await send('t2', 'needs-you', 'notification')) === 409);
  check('send refused at permission', (await send('t2', 'permission')) === 409);
  for (const st of ['waiting', 'blocked', 'stopped']) {
    check(`send goes through at ${st}`, (await send('t3', st)) === 200, st);
  }
  const m = await row('t3');
  check('displayStatus of blocked is blocked', (await (async () => { await get(port, '/rename-terminal?name=t3&status=blocked'); return (await row('t3')).displayStatus; })()) === 'blocked', m);

  // a stored `waiting` stops reading as waiting once the work has ended
  await get(port, '/rename-terminal?name=t4&status=waiting');
  await get(port, '/bg-task?name=t4&op=start');
  check('waiting with work outstanding shows bg-task', (await row('t4')).displayStatus === 'bg-task', await row('t4'));
  await get(port, '/bg-task?name=t4&op=end');
  check('waiting with no work left shows stopped', (await row('t4')).displayStatus === 'stopped', await row('t4'));

  // hooks
  const stop = '{"hook_event_name":"Stop","last_assistant_message":"done"}';
  check('handed-off Stop → stopped', hook('idle', stop, 0) === 'stopped');
  check('handed-off Stop with bg work → waiting', hook('idle', stop, 2) === 'waiting');
  const nudge = '{"hook_event_name":"Notification","notification_type":"idle_prompt"}';
  check('idle nudge → stopped', hook('needs-input', nudge, 0) === 'stopped');
  check('Notification permission → needs-you', hook('needs-input', '{"notification_type":"permission_prompt"}', 0) === 'needs-you');
  check('needs-you accepted by the hook too', hook('needs-you', '{"notification_type":"permission_prompt"}', 0) === 'needs-you');

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
