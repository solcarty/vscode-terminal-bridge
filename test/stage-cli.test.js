// a consumer that sets a stage against a bridge older than v0.34.0
// gets exit 4 and {"reason":"unsupported-by-bridge"}: documented as ignorable.
// The fake bridge answers an unknown route the way a real old one does.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/ping')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end('Not found');
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cli-'));
  fs.writeFileSync(path.join(cwd, '.vscode-bridge-port'), String(port));
  const env = { ...process.env };
  delete env.VSCODE_BRIDGE_PORT;
  const cli = path.join(__dirname, '..', 'bin', 'bridgectl.sh');
  const run = (...args) => new Promise(resolve => {
    require('child_process').execFile('bash', [cli, ...args], { cwd, env }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
  (async () => {
    const r = await run('stage', 'x', 'build');
    check('an older bridge → exit 4', r.code === 4, r);
    check('…with the unsupported-by-bridge reason', r.out.includes('unsupported-by-bridge'), r);
    server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
    process.exit(fails ? 1 : 0);
  })();
});
