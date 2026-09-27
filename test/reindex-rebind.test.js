// #64 — reindex must never re-bind a name whose terminal is still open.
//
// A feature loop ran in a tab at the house.health repo root. A VS Code task
// terminal then opened at the same cwd, and reindex (which runs on focus, on
// shell-integration events and before open/close/send) handed it the loop's
// name: every later `rename` from the loop landed on the task's tab, `list`
// reported the loop dead, and when the task terminal closed it took the name's
// metadata with it, leaving the real loop tab untracked for good.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

const KEY = 'terminalBridgeMetadata';
const ROOT = '/tmp/repo-root';
const DEAD_PID = 999991;                 // never a live process in practice
const OTHER_PID = process.ppid;          // alive, but not the loop's shell

h.state.set(KEY, {
  // The loop's tab — tracked, recorded pid is its (live) shell.
  'feat-1':   { cwd: ROOT, status: 'working', pid: process.pid },
  // Two rows sharing one cwd with no live owner: cwd alone is ambiguous.
  'amb-a':    { cwd: '/tmp/shared', status: 'idle', pid: DEAD_PID },
  'amb-b':    { cwd: '/tmp/shared', status: 'idle', pid: OTHER_PID },
  // A row whose recorded pid is alive and belongs to some other process.
  'owned':    { cwd: '/tmp/owned', status: 'idle', pid: process.pid },
  // A plain single-name cwd row with no pid: the ordinary reload case.
  'solo':     { cwd: '/tmp/solo', status: 'idle' },
});

const withCwd = (t, cwd) => { t.shellIntegration = { cwd: { fsPath: cwd } }; return t; };

const loop = h.addTerminal(withCwd(h.makeTerminal('feat-1', process.pid), ROOT));

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

  await get(port, '/reindex');
  check('the loop tab is bound to its name at startup', (await row('feat-1'))?.pid === process.pid, await row('feat-1'));

  // 1. A task terminal opens at the loop's cwd and reindex runs.
  const task = h.addTerminal(withCwd(h.makeTerminal('deploy-prod', OTHER_PID), ROOT));
  h.fireShellIntegration(task);
  const r = JSON.parse((await get(port, '/reindex')).body);
  check('a new terminal at a live name\'s cwd is not re-indexed', r.reindexed === 0, r);

  const feat = await row('feat-1');
  check('list still reports the loop tab\'s own pid', feat && feat.pid === process.pid, feat);
  check('the name is still live', feat && feat.pidAlive === true, feat);

  h.renames.length = 0;
  await get(port, '/rename-terminal?name=feat-1&label=feat-1%20tick');
  check('rename lands on the loop tab, not the task terminal',
    h.renames.length === 1 && h.renames[0].terminal === 'feat-1', h.renames);

  // 2. A terminal with the same name as a live tracked one does not steal it.
  const twin = h.addTerminal(h.makeTerminal('feat-1', OTHER_PID));
  await get(port, '/reindex');
  h.renames.length = 0;
  await get(port, '/rename-terminal?name=feat-1&label=again');
  check('a same-named second terminal does not take a live name (strategy A)',
    h.renames.length === 1 && h.renames[0].terminal === 'feat-1' && loop.displayName === 'again'
      && twin.displayName === undefined, { renames: h.renames, twin: twin.displayName });

  // 3. Closing untracked / foreign terminals never deletes another name's row.
  await h.closeTerminal(task);
  await h.closeTerminal(twin);
  check('closing an untracked terminal keeps the loop\'s metadata', !!h.state.get(KEY)['feat-1'], Object.keys(h.state.get(KEY)));
  check('the loop is still bound after the foreign tab closed', (await row('feat-1'))?.pid === process.pid, await row('feat-1'));
  const stray = h.addTerminal(h.makeTerminal('nobody', OTHER_PID));
  await h.closeTerminal(stray);
  check('closing a terminal no name was ever bound to deletes nothing',
    Object.keys(h.state.get(KEY)).length === 5, Object.keys(h.state.get(KEY)));

  // 4. Ambiguous cwd: two persisted names, the terminal's pid matches neither.
  const guess = h.addTerminal(withCwd(h.makeTerminal('zsh', 4242), '/tmp/shared'));
  await get(port, '/reindex');
  check('an ambiguous cwd is not bound by guess',
    !(await row('amb-a'))?.live && !(await row('amb-b'))?.live, [await row('amb-a'), await row('amb-b')]);
  await h.closeTerminal(guess);

  // ...but a pid that picks out exactly one of them does bind.
  const pick = h.addTerminal(withCwd(h.makeTerminal('zsh', OTHER_PID), '/tmp/shared'));
  await get(port, '/reindex');
  h.renames.length = 0;
  await get(port, '/rename-terminal?name=amb-b&label=picked');
  check('an ambiguous cwd binds when the shell pid disambiguates',
    pick.displayName === 'picked', { renames: h.renames });

  // 5. A live recorded pid that isn't this terminal's shell vetoes the cwd match.
  const imposter = h.addTerminal(withCwd(h.makeTerminal('zsh', OTHER_PID), '/tmp/owned'));
  await get(port, '/reindex');
  h.renames.length = 0;
  await get(port, '/rename-terminal?name=owned&label=nope');
  check('a live pid owned by another process vetoes the cwd match', imposter.displayName === undefined, { renames: h.renames });

  // 6. The ordinary reload case still works: one name, no pid, unbound.
  const revived = h.addTerminal(withCwd(h.makeTerminal('zsh', 4343), '/tmp/solo'));
  const r2 = JSON.parse((await get(port, '/reindex')).body);
  await get(port, '/rename-terminal?name=solo&label=back');
  check('an unbound single-name cwd still re-binds after a reload', r2.reindexed === 1 && revived.displayName === 'back', r2);

  console.log(fails ? `\n${fails} failing` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
