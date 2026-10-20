// #6561 — every client write ends one of three ways, and each has its own exit
// code: refused (1, the bridge answered no), unreachable (3, no connection and
// ping fails too), unconfirmed (5, sent, no reply in time). A timeout must never
// print bridge-unreachable, because the write may have happened.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

// mode decides what /send-text, /rename-terminal etc. do.
let mode = 'ok';
const hits = [];
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/ping') return json(res, 200, { ok: true });
  hits.push(p);
  if (mode === 'hang') return;                       // accept, never answer
  if (mode === 'refuse') return json(res, 409, { ok: false, error: 'Terminal is at an interactive prompt' });
  if (p === '/close-terminal' && mode === 'untracked') return json(res, 404, { ok: false, outcome: 'not-tracked' });
  json(res, 200, { ok: true, outcome: 'closed' });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'write-outcomes-'));
  const deadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-outcomes-dead-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'write-outcomes-home-'));
  fs.writeFileSync(path.join(cwd, '.vscode-bridge-port'), String(port));
  // a port nothing listens on: bind then free it
  const free = await new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => r(q)); }); });
  fs.writeFileSync(path.join(deadDir, '.vscode-bridge-port'), String(free));

  const env = { ...process.env, HOME: home, VSCODE_BRIDGE_WRITE_MAX: '1' };
  delete env.VSCODE_BRIDGE_PORT;
  const cli = path.join(__dirname, '..', 'bin', 'bridgectl.sh');
  const run = (dir, ...args) => new Promise(resolve => {
    const child = execFile('bash', [cli, ...args], { cwd: dir, env }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, out: stdout, err: stderr }));
    child.stdin.end();   // hook-status drains stdin to EOF
  });

  mode = 'ok';
  let r = await run(cwd, 'send', 'w', 'hi');
  check('send ok → 0', r.code === 0 && r.out.includes('"ok":true'), r);
  r = await run(cwd, 'status', 'w', 'working');
  check('status ok → 0', r.code === 0, r);

  mode = 'refuse';
  r = await run(cwd, 'send', 'w', 'hi');
  check('send refused → 1, with the bridge\'s reason', r.code === 1 && r.out.includes('interactive prompt'), r);
  r = await run(cwd, 'nudge', 'w');
  check('nudge refused → 1', r.code === 1, r);
  r = await run(cwd, 'status', 'w', 'working');
  check('status refused exits non-zero (no || true)', r.code === 1, r);
  r = await run(cwd, 'open', 'w', cwd);
  check('open refused → 1', r.code === 1, r);

  mode = 'hang';
  for (const [label, args] of [
    ['send', ['send', 'w', 'hi']], ['nudge', ['nudge', 'w']], ['status', ['status', 'w', 'idle']],
    ['close', ['close', 'w']], ['open', ['open', 'w', cwd]],
  ]) {
    r = await run(cwd, ...args);
    check(`${label} timed out → 5 unconfirmed`, r.code === 5, r);
    check(`${label} timeout never says bridge-unreachable`, !(r.out + r.err).includes('bridge-unreachable') && !(r.err.includes('unreachable')), r);
  }
  r = await run(cwd, 'send', 'w', 'hi');
  check('send timeout names unconfirmed on stdout', r.out.includes('"reason":"unconfirmed"'), r);

  mode = 'untracked';
  r = await run(cwd, 'close', 'gone');
  check('close not-tracked stays exit 0', r.code === 0 && r.out.includes('not-tracked'), r);

  for (const [label, args] of [
    ['send', ['send', 'w', 'hi']], ['nudge', ['nudge', 'w']], ['status', ['status', 'w', 'idle']],
    ['close', ['close', 'w']], ['open', ['open', 'w', deadDir]],
  ]) {
    r = await run(deadDir, ...args);
    check(`${label} with nothing listening → 3 unreachable`, r.code === 3, r);
  }
  r = await run(deadDir, 'send', 'w', 'hi');
  check('send unreachable says bridge-unreachable', r.out.includes('bridge-unreachable'), r);

  mode = 'hang';
  r = await run(cwd, 'hook-status', 'working', '--name=w');
  check('a hook never fails the turn, whatever the write did', r.code === 0, r);

  server.close();
  for (const d of [cwd, deadDir, home]) fs.rmSync(d, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
});
