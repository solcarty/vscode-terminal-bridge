// Tab titles landing on the wrong tab. renameWithArg renames whichever
// terminal is ACTIVE, so applyPresentation() is show(target) → rename →
// restore. Without a lock, concurrent /rename-terminal calls interleave across
// the await and A's label lands on B; without waiting for show() to take
// effect, the rename hits whatever was active before. The harness delays
// activation here the way the real ext-host → main-thread hop does.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
const NAMES = ['w1', 'w2', 'w3', 'w4', 'w5'];
const meta = {};
for (const n of NAMES) meta[n] = { cwd: `/tmp/${n}`, baseLabel: n, label: n };
meta.stuck = { cwd: '/tmp/stuck', baseLabel: 'stuck', label: 'stuck' };
h.state.set(KEY, meta);
const tabs = Object.fromEntries([...NAMES, 'stuck'].map(n => [n, h.addTerminal(h.makeTerminal(n))]));

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
  const titles = () => Object.fromEntries(Object.entries(tabs).map(([n, t]) => [n, t.displayName]));

  // ── Concurrent renames, slow activation ───────────────────────────────────
  tabs.stuck.show();                       // the user is looking at some other tab
  const base = h.activeTerminal;
  h.showBehavior.delayMs = 15;
  const rs = await Promise.all(NAMES.map(n =>
    get(port, `/rename-terminal?name=${n}&status=working&label=${encodeURIComponent(`${n} label`)}`)));
  const bodies = rs.map(r => JSON.parse(r.body));
  check('every concurrent rename reports applied', bodies.every(b => b.applied === true), bodies);
  check('each tab wears its own title',
    NAMES.every(n => tabs[n].displayName === `$(loading~spin) ${n} label`), titles());
  check('the previously active terminal is restored', h.activeTerminal === base,
    h.activeTerminal && h.activeTerminal.name);

  // A second burst, mixing statuses, still lands every title on its own tab.
  await Promise.all(NAMES.map((n, i) =>
    get(port, `/rename-terminal?name=${n}&status=${i % 2 ? 'idle' : 'needs-input'}`)));
  check('a mixed second burst also lands correctly',
    NAMES.every((n, i) => tabs[n].displayName === `$(${i % 2 ? 'debug-pause' : 'bell-dot'}) ${n} label`), titles());

  // ── show() never takes effect → the rename is skipped, not misapplied ────
  h.showBehavior.delayMs = 0;
  tabs.w1.show();                          // some other tab is active
  h.showBehavior.ignore = true;
  const activeBefore = h.activeTerminal;
  const renamesBefore = h.renames.length;
  let j = JSON.parse((await get(port, '/rename-terminal?name=stuck&status=working')).body);
  check('rename is skipped when the target never becomes active',
    h.renames.length === renamesBefore, h.renames.slice(renamesBefore));
  check('...and reported as applied:false with a reason', j.applied === false && j.reason === 'not-active', j);
  check('...the active tab kept its title',
    !activeBefore || activeBefore.displayName !== '$(loading~spin) stuck', activeBefore && activeBefore.displayName);
  const stuckRow = JSON.parse((await get(port, '/list')).body).terminals.find(t => t.name === 'stuck');
  check('...and the unapplied label is not persisted', stuckRow.label === 'stuck', stuckRow);

  // The next identical call retries instead of short-circuiting as a no-op.
  h.showBehavior.ignore = false;
  j = JSON.parse((await get(port, '/rename-terminal?name=stuck&status=working')).body);
  check('the next identical call retries and applies', j.applied === true && !j.noOp
    && tabs.stuck.displayName === '$(loading~spin) stuck', { j, title: tabs.stuck.displayName });

  // ── Self-heal: a tab whose live title drifted is repaired ────────────────
  j = JSON.parse((await get(port, '/rename-terminal?name=stuck&status=working')).body);
  check('identical call on a correct tab stays a no-op', j.noOp === true, j);
  tabs.stuck.name = '$(loading~spin) w1 label';          // someone else's title landed here
  j = JSON.parse((await get(port, '/rename-terminal?name=stuck&status=working')).body);
  check('a drifted title is repaired on the next identical call',
    !j.noOp && j.applied === true && h.renames.at(-1).name === '$(loading~spin) stuck', { j, last: h.renames.at(-1) });
  tabs.stuck.name = '$(loading~spin) stuck';             // VS Code synced the title back
  j = JSON.parse((await get(port, '/rename-terminal?name=stuck&status=working')).body);
  check('a synced title is not re-renamed', j.noOp === true, j);
  tabs.stuck.name = 'stuck';                             // ext host never synced it
  j = JSON.parse((await get(port, '/rename-terminal?name=stuck&status=working')).body);
  check('an unsynced creation name is not treated as drift', j.noOp === true, j);

  // ── /repaint redraws stored labels through the same lock ─────────────────
  for (const n of NAMES) tabs[n].displayName = 'WRONG';
  h.showBehavior.delayMs = 10;
  j = JSON.parse((await get(port, '/repaint')).body);
  check('/repaint reports every tracked tab', j.ok && j.terminals.length === NAMES.length + 1 && j.skipped === 0, j);
  check('/repaint restores each tab\'s stored label',
    NAMES.every((n, i) => tabs[n].displayName === `$(${i % 2 ? 'debug-pause' : 'bell-dot'}) ${n} label`), titles());

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
