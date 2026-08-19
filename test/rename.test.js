// Regression cover for /rename-terminal, which #40 rerouted through the shared
// applyPresentation() renderer. Everything here is pre-existing behaviour that
// must survive that refactor.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, { 'tab': { cwd: '/tmp/t', baseLabel: 'tab', label: 'tab' } });
h.addTerminal(h.makeTerminal('tab'));

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

  // status= prefixes the canonical codicon and applies the canonical color
  let j = JSON.parse((await get(port, '/rename-terminal?name=tab&status=working')).body);
  check('status= prefixes the codicon', j.label === '$(loading~spin) tab', j);
  check('status= applies the canonical color', j.color === 'terminal.ansiCyan', j);
  check('baseLabel stays clean', j.baseLabel === 'tab', j);

  // idempotent repeats are no-ops but still heartbeat
  const beforeHb = (await row('tab')).lastHeartbeatAt;
  const beforeStatusChange = (await row('tab')).statusChangedAt;
  await wait(5);
  j = JSON.parse((await get(port, '/rename-terminal?name=tab&status=working')).body);
  check('repeat status= is a no-op', j.noOp === true, j);
  check('...but still stamps a heartbeat', (await row('tab')).lastHeartbeatAt !== beforeHb, await row('tab'));
  check('...and does not reset statusChangedAt', (await row('tab')).statusChangedAt === beforeStatusChange, await row('tab'));

  // a real status change moves statusChangedAt
  await wait(5);
  await get(port, '/rename-terminal?name=tab&status=needs-input');
  check('changing status moves statusChangedAt', (await row('tab')).statusChangedAt !== beforeStatusChange, await row('tab'));

  // status=none strips the prefix
  j = JSON.parse((await get(port, '/rename-terminal?name=tab&status=none')).body);
  check('status=none strips the codicon prefix', j.label === 'tab', j);
  check('status=none clears the stored status', (await row('tab')).status === null, await row('tab'));

  // legacy label= mode: caller owns the whole string
  j = JSON.parse((await get(port, '/rename-terminal?name=tab&label=my%20label')).body);
  check('legacy label= sets the label verbatim', j.label === 'my label', j);

  // explicit color beats the status default
  j = JSON.parse((await get(port, '/rename-terminal?name=tab&status=working&color=terminal.ansiMagenta')).body);
  check('explicit color= overrides the status color', j.color === 'terminal.ansiMagenta', j);

  // quiet mode: color/status recorded, label untouched
  const labelBefore = (await row('tab')).label;
  j = JSON.parse((await get(port, '/rename-terminal?name=tab&quiet=1&status=error')).body);
  check('quiet=1 reports quiet', j.quiet === true && j.label === null, j);
  check('quiet=1 records the status', (await row('tab')).status === 'error', await row('tab'));
  check('quiet=1 leaves the label alone', (await row('tab')).label === labelBefore, await row('tab'));
  check('quiet=1 applies the status color', j.color === 'terminal.ansiRed', j);

  // validation + unknown target
  let r = await get(port, '/rename-terminal?name=tab');
  check('no label/status/quiet → 400', r.code === 400, r.body);
  r = await get(port, '/rename-terminal?name=nope&status=working');
  check('unknown name → 404', r.code === 404, r.body);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
