// #38, remote half — a worker on another machine has no shared filesystem with
// the orchestrating session, so a note has to ride the same HTTP rail the job
// itself uses. This exercises bin/worker.js directly (it has no vscode
// dependency): POST /job-note, then read it back off /job-status the way
// bridge-tail.sh does before relaying it into the local bridge.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN = 'test-token-abc';
const PORT = Number(process.env.VSCODE_BRIDGE_BASE_PORT || 41415) + 5;
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-repo-'));

const worker = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'worker.js')], {
  env: { ...process.env, WORKER_TOKEN: TOKEN, WORKER_REPO_DIR: REPO_DIR, WORKER_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const req = (method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({
    host: '127.0.0.1', port: PORT, path: p, method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b }));
  });
  r.on('error', reject);
  if (body !== undefined) r.write(body);
  r.end();
});

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await wait(100);
    try { await req('GET', '/ping'); up = true; } catch { /* still booting */ }
  }

  let fails = 0;
  const check = (label, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
    if (!cond) fails++;
  };
  const done = () => {
    worker.kill();
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
    console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
    process.exit(fails ? 1 : 0);
  };

  if (!up) { console.log('FAIL  worker daemon never came up'); return done(); }

  const receipt = 'state: blocked\nneeds-decision: bump the schema or gate it\n';
  let r = await req('POST', '/job-note?id=job-1', receipt);
  let j = JSON.parse(r.body);
  check('POST /job-note → 200', r.code === 200 && j.ok === true, j);
  check('reports bytes + truncation', j.bytes === Buffer.byteLength(receipt) && j.truncated === false, j);

  r = await req('GET', '/job-status?id=job-1&offset=0');
  j = JSON.parse(r.body);
  check('job-status carries the note home', j.note === receipt, j);
  check('job-status carries noteUpdatedAt for change detection', typeof j.noteUpdatedAt === 'string', j);

  // a job that published nothing must not look like it published an empty note
  r = await req('GET', '/job-status?id=job-2&offset=0');
  j = JSON.parse(r.body);
  check('job with no note reports null, not empty string', j.note === null && j.noteUpdatedAt === null, j);

  // re-publishing replaces
  await req('POST', '/job-note?id=job-1', 'state: done\n');
  j = JSON.parse((await req('GET', '/job-status?id=job-1&offset=0')).body);
  check('re-publishing replaces the note', j.note === 'state: done\n', j);

  // cap
  j = JSON.parse((await req('POST', '/job-note?id=job-1', 'x'.repeat(9000))).body);
  check('oversized job note truncated at the same cap', j.truncated === true && j.bytes === 4096, j);

  // auth + id validation
  r = await req('POST', '/job-note?id=../escape', 'hi');
  check('path-traversal job id rejected', r.code === 400, r.body);

  const noAuth = await new Promise(resolve => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/job-note?id=job-1', method: 'POST' },
      res => { res.resume(); resolve(res.statusCode); });
    rq.end('hi');
  });
  check('unauthenticated job note rejected', noAuth === 401, noAuth);

  done();
})();
