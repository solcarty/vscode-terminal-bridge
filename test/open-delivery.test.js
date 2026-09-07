// #52 — open must not claim success for a command it never delivered.
// #53 — open must be idempotent by name, or a client timeout plus a retry
//       leaves two tabs against one registry row.
process.env.VSCODE_BRIDGE_CMD_FALLBACK_MS = '120';   // must precede harness load

const h = require('./harness');
const http = require('http');
const fs = require('fs');

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
  const row = async n =>
    JSON.parse((await get(port, '/list')).body).terminals.find(t => t.name === n);

  // ── #52: delivery is reported, not assumed ──────────────────────────────
  let j = JSON.parse((await get(port, '/open-terminal?name=conf&cwd=/tmp/a&cmd=echo%20hi')).body);
  check('open does not claim the command ran', j.ok && j.delivery === 'pending', j);
  check('open reports it created rather than reused', j.reused === false, j);
  check('cmdDelivery is unset until delivery actually happens',
    (await row('conf'))?.cmdDelivery == null, await row('conf'));

  h.fireShellIntegration(h.findTerminal('conf'));
  await wait(20);
  let r = await row('conf');
  check('a shell that reported ready records a confirmed delivery',
    r && r.cmdDelivery === 'shell-integration', r);
  check('delivery is timestamped', r && typeof r.cmdDeliveredAt === 'string', r);

  // Blind path: shell integration never fires, fallback writes anyway.
  await get(port, '/open-terminal?name=blind&cwd=/tmp/b&cmd=echo%20hi');
  await wait(300);
  r = await row('blind');
  check('a shell that never reported ready is recorded as written blind, not confirmed',
    r && r.cmdDelivery === 'timeout', r);

  // No command means nothing to deliver, and must not read as a failed one.
  await get(port, '/open-terminal?name=bare&cwd=/tmp/c');
  await wait(300);
  r = await row('bare');
  check('a tab opened with no command reports none, not timeout',
    r && r.cmdDelivery === 'none', r);

  // ── #53: idempotency by name ────────────────────────────────────────────
  check('one tab exists for the name before the retry', h.countTerminals('conf') === 1,
    h.countTerminals('conf'));

  j = JSON.parse((await get(port, '/open-terminal?name=conf&cwd=/tmp/a&cmd=echo%20hi')).body);
  check('a retry against a live name reuses rather than creating', j.ok && j.reused === true, j);
  check('the command is not re-run into a tab that may already have an agent',
    j.delivery === 'skipped-reused', j);
  check('the retry did NOT create a second tab', h.countTerminals('conf') === 1,
    h.countTerminals('conf'));

  const rows = JSON.parse((await get(port, '/list')).body).terminals;
  check('still exactly one registry row for the name',
    rows.filter(t => t.name === 'conf').length === 1, rows.map(t => t.name));

  // A tracked name whose terminal is gone is a stale row, and must still create.
  h.findTerminal('blind').dispose();
  j = JSON.parse((await get(port, '/open-terminal?name=blind&cwd=/tmp/b&cmd=echo%20hi')).body);
  check('a stale row does not block a genuine relaunch', j.ok && j.reused === false, j);
  check('the relaunch created exactly one tab', h.countTerminals('blind') === 1,
    h.countTerminals('blind'));

  console.log(fails ? `\n${fails} failing` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
