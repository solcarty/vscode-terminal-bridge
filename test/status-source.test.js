// #68 — send/nudge refuse only a PENDING prompt. A `needs-input` the agent set
// itself (bridgectl status) or one the Stop hook promoted is a flag for the
// orchestrator, not a menu. Unknown source stays refused (fail-safe).
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const KEY = 'terminalBridgeMetadata';
const names = ['real', 'self', 'promo', 'legacy', 'perm'];
h.state.set(KEY, {
  real:   { cwd: '/tmp/a', status: 'needs-input', statusSource: 'notification' },
  self:   { cwd: '/tmp/b', status: 'needs-input', statusSource: 'manual' },
  promo:  { cwd: '/tmp/c', status: 'needs-input', statusSource: 'stop-promotion' },
  legacy: { cwd: '/tmp/d', status: 'needs-input' },
  perm:   { cwd: '/tmp/e', status: 'permission', statusSource: 'manual' },
});
for (const n of names) h.addTerminal(h.makeTerminal(n));
h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
  });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

// hook-status: which source does it hand to bridge_status?
const SH = path.join(__dirname, '..', 'bin', 'vscode-bridge.sh');
const hookSource = (state, payload, env = '') => {
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(SH)}
     export VSCODE_BRIDGE_HOME=$(mktemp -d)
     _bridge_idle_needs_note() { return 0; }
     bridge_status() { echo "SRC:$2:$3"; }
     ${env}
     bridge_hook_status ${state} --name=t1`,
  ], { input: payload, encoding: 'utf8' });
  return ((r.stdout || '').match(/SRC:\S*/) || ['<none>'])[0];
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

  for (const [n, code, why] of [
    ['real', 409, 'Notification needs-input'], ['legacy', 409, 'unknown source'], ['perm', 409, 'permission'],
    ['self', 200, 'bridgectl-set needs-input'], ['promo', 200, 'Stop-promoted needs-input'],
  ]) {
    const s = await get(port, `/send-text?name=${n}&text=hi`);
    check(`send: ${why} → ${code}`, s.code === code, s);
    const nu = await get(port, `/nudge-terminal?name=${n}`);
    check(`nudge: ${why} → ${code}`, nu.code === code, nu);
  }
  const refused = JSON.parse((await get(port, '/send-text?name=real&text=hi')).body);
  check('refusal message is unchanged', /interactive prompt \(status=needs-input\); text would be read as an answer/.test(refused.error), refused);

  check('list reports statusSource', (await row('self')).statusSource === 'manual' && (await row('legacy')).statusSource === null, await row('self'));

  // source is stored with the status and cleared when the value changes
  await get(port, '/rename-terminal?name=legacy&status=needs-input&source=notification');
  check('source recorded with the status', (await row('legacy')).statusSource === 'notification', await row('legacy'));
  await get(port, '/rename-terminal?name=legacy&status=working');
  check('source cleared when status changes', (await row('legacy')).statusSource === null, await row('legacy'));
  await get(port, '/rename-terminal?name=legacy&status=needs-input');
  check('a later source-less needs-input is not read through a stale source',
    (await row('legacy')).statusSource === null && (await get(port, '/send-text?name=legacy&text=x')).code === 409, await row('legacy'));
  await get(port, '/rename-terminal?name=legacy&status=needs-input&source=bogus');
  check('unrecognised source is ignored', (await row('legacy')).statusSource === null, await row('legacy'));

  // a pending prompt's source is not downgraded by a same-value manual write
  await get(port, '/rename-terminal?name=real&status=needs-input&source=manual');
  check('same-value manual write keeps notification source', (await row('real')).statusSource === 'notification', await row('real'));

  // hook-status sources
  check('Notification needs-input → notification',
    hookSource('needs-input', '{"notification_type":"permission_prompt"}') === 'SRC:needs-you:notification', hookSource('needs-input', '{"notification_type":"permission_prompt"}'));
  check('Stop with no handoff → blocked, source stop-promotion',
    hookSource('idle', '{"hook_event_name":"Stop"}') === 'SRC:blocked:stop-promotion', hookSource('idle', '{"hook_event_name":"Stop"}'));

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
