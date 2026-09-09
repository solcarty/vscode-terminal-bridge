// house.health#4589 — `pidAlive` only ever proves the terminal's SHELL is
// there. A finished worker, a worker blocked on a real question, and a bare
// shell left behind by a crashed agent all read `pidAlive: true`, because
// the tracked pid IS the shell by this bridge's own design. Every caller was
// reimplementing `pgrep -P <pid>` by hand to tell them apart — and getting
// it wrong: `ps -p <tracked-pid> -o command` reads `/bin/zsh -il` for a
// healthy tab too. `agentAlive` runs that check once, in the bridge.
//
// This spawns REAL processes (not mocked) because the whole point is
// exercising the actual `pgrep -P` / `ps -o command=` shellout against a
// live parent/child relationship — a mock would just assert the code calls
// what it calls, not that the triage is correct.
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const KEY = 'terminalBridgeMetadata';

// shell1: a "healthy tab" — a live shell process with a live child whose
// command matches /claude/i, the same shape a real bridge_open + claude
// session has.
const shell1 = spawn('bash', ['-c', '(exec -a claude sleep 30) & wait'], { stdio: 'ignore' });
// shell2: a "bare shell" — a live shell process with NO children at all,
// the shape left behind once an agent inside it crashes or exits.
const shell2 = spawn('bash', ['-c', 'sleep 30'], { stdio: 'ignore' });

h.state.set(KEY, {
  'with-agent': { cwd: '/tmp/a', status: 'working', pid: shell1.pid },
  'bare-shell': { cwd: '/tmp/b', status: 'idle', pid: shell2.pid },
  // Shell confirmed dead outright — agentAlive must be false, not null, and
  // must not spend a pgrep/ps read on a pid that can't have children alive.
  'dead-shell': { cwd: '/tmp/c', status: 'idle', pid: 999996 },
});

h.addTerminal(h.makeTerminal('with-agent', shell1.pid));
h.addTerminal(h.makeTerminal('bare-shell', shell2.pid));
h.addTerminal(h.makeTerminal('dead-shell', 999996));

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

  // Give the two spawned shells a beat to actually land their children.
  await wait(300);

  let fails = 0;
  const check = (label, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
    if (!cond) fails++;
  };

  await get(port, '/reindex');
  const rows = JSON.parse((await get(port, '/list')).body).terminals;
  const row = n => rows.find(t => t.name === n);

  const withAgent = row('with-agent');
  check('a shell with a live claude child reports pidAlive true',
    withAgent && withAgent.pidAlive === true, withAgent);
  check('...and agentAlive true',
    withAgent && withAgent.agentAlive === true, withAgent);

  const bare = row('bare-shell');
  check('a bare shell (no children) still reports pidAlive true — it IS alive',
    bare && bare.pidAlive === true, bare);
  check('...but agentAlive false — this is exactly what pidAlive alone cannot tell you',
    bare && bare.agentAlive === false, bare);

  const dead = row('dead-shell');
  check('a confirmed-dead shell reports pidAlive false',
    dead && dead.pidAlive === false, dead);
  check('...and agentAlive false, without a wasted child-process read',
    dead && dead.agentAlive === false, dead);

  console.log(fails ? `\n${fails} failing` : '\nall green');
  shell1.kill();
  shell2.kill();
  process.exit(fails ? 1 : 0);
})();
