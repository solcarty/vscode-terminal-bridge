// A terminal's title is the name it was created with, and nothing the bridge
// does afterwards changes it (#6942). VS Code can only rename the ACTIVE
// terminal, so every rename was show(target) → rename → restore, and under a
// dozen agents changing status at once titles landed on the wrong tabs. Now
// rename and status write the registry only: no renameWithArg, no show(), no
// change of active terminal, no icon or color assignment.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
const NAMES = ['w1', 'w2', 'w3', 'w4', 'w5'];
const meta = {};
for (const n of NAMES) meta[n] = { cwd: `/tmp/${n}`, baseLabel: n, label: n };
meta.user = { cwd: '/tmp/user', baseLabel: 'user', label: 'user' };
h.state.set(KEY, meta);
const tabs = Object.fromEntries([...NAMES, 'user'].map(n => [n, h.addTerminal(h.makeTerminal(n))]));

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
  const rows = async () => Object.fromEntries(
    JSON.parse((await get(port, '/list')).body).terminals.map(t => [t.name, t]));

  // The user is looking at a sixth tab.
  tabs.user.show();
  const showsBefore = Object.fromEntries(NAMES.map(n => [n, tabs[n].shows]));

  // ── Concurrent status + rename bursts on the other five ──────────────────
  let rs = await Promise.all(NAMES.map(n =>
    get(port, `/rename-terminal?name=${n}&status=working&label=${encodeURIComponent(`${n} 1/2/3 next 16:10`)}`)));
  check('every call succeeds', rs.every(r => r.code === 200 && JSON.parse(r.body).applied === true),
    rs.map(r => r.body));
  rs = await Promise.all(NAMES.map((n, i) =>
    get(port, `/rename-terminal?name=${n}&status=${i % 2 ? 'idle' : 'needs-input'}&icon=rocket&color=terminal.ansiRed`)));
  rs = await Promise.all([
    ...NAMES.map(n => get(port, `/rename-terminal?name=${n}&label=${encodeURIComponent(`${n} legacy`)}`)),
    ...NAMES.map(n => get(port, `/rename-terminal?name=${n}&quiet=1&status=working&icon=rocket`)),
    get(port, '/repaint'),
  ]);
  rs = rs.concat(await Promise.all(NAMES.map(n => get(port, `/bg-task?name=${n}&op=start`))));
  check('every mixed call succeeds', rs.every(r => r.code === 200), rs.map(r => r.body));

  // ── The tabs ─────────────────────────────────────────────────────────────
  check('no renameWithArg was ever issued', h.renames.length === 0, h.renames);
  check('the user\'s tab is still the active terminal', h.activeTerminal === tabs.user,
    h.activeTerminal && h.activeTerminal.name);
  check('none of the five was shown',
    NAMES.every(n => tabs[n].shows === showsBefore[n]), NAMES.map(n => tabs[n].shows));
  check('every terminal keeps its creation name',
    [...NAMES, 'user'].every(n => tabs[n].name === n && tabs[n].displayName === undefined),
    Object.values(tabs).map(t => [t.name, t.displayName]));
  check('no icon or color was assigned to any terminal',
    Object.values(tabs).every(t => !('iconPath' in t) && !('color' in t)),
    Object.values(tabs).map(t => [t.iconPath, t.color]));

  // ── The registry ─────────────────────────────────────────────────────────
  const r = await rows();
  check('/list label is the legacy label, with the bg-task codicon as before',
    NAMES.every(n => r[n].label === `$(server-process) ${n} legacy`), NAMES.map(n => r[n].label));
  check('/list displayStatus reflects status + background work',
    NAMES.every(n => r[n].status === 'working' && r[n].displayStatus === 'bg-task'),
    NAMES.map(n => [r[n].status, r[n].displayStatus]));

  // status= after a label stores the codicon-prefixed label, as before
  const j = JSON.parse((await get(port, '/rename-terminal?name=w1&status=needs-input&label=w1%20task')).body);
  check('status= stores the codicon-prefixed label', j.label === '$(bell-dot) w1 task', j);
  check('...and /list reports it', (await rows()).w1.label === '$(bell-dot) w1 task', (await rows()).w1);
  check('...still without touching the tab', tabs.w1.name === 'w1' && h.renames.length === 0
    && h.activeTerminal === tabs.user, { name: tabs.w1.name, renames: h.renames });

  // /repaint keeps its shape but has nothing to redraw
  const rp = JSON.parse((await get(port, '/repaint')).body);
  check('/repaint reports every tab as skipped, titles fixed',
    rp.ok && rp.repainted === 0 && rp.skipped === 6 && rp.terminals.every(t => t.reason === 'titles-fixed'), rp);

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
