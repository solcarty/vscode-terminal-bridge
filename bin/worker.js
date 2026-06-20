#!/usr/bin/env node
// Headless job-execution daemon for remote nodes (Mac Mini, homelab VM, ...).
//
// Unlike extension.js, this has NO dependency on the `vscode` module — it runs
// as a plain Node process under launchd on a machine with no VS Code window
// open. It accepts jobs over HTTP from a laptop's bridge extension, runs each
// one in its own git worktree (cut from a fetched SHA, so every job starts
// from current `main` without needing a background sync loop), and executes
// the command inside an `rmux` session so it survives the requesting laptop
// going to sleep or closing its lid.
//
// Required env vars:
//   WORKER_TOKEN    shared secret — every request must send
//                   `Authorization: Bearer <token>` matching this.
//   WORKER_REPO_DIR path to a canonical clone of the repo jobs run against.
// Optional:
//   WORKER_PORT     default 31416 (deliberately not 31415, so a worker and a
//                   local bridge are never confused even run on the same host).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const TOKEN = process.env.WORKER_TOKEN;
const REPO_DIR = process.env.WORKER_REPO_DIR;
const PORT = Number(process.env.WORKER_PORT) || 31416;

if (!TOKEN) {
  console.error('[worker] WORKER_TOKEN is required');
  process.exit(1);
}
if (!REPO_DIR) {
  console.error('[worker] WORKER_REPO_DIR is required');
  process.exit(1);
}

const WORKTREES_DIR = `${REPO_DIR}-worktrees`;
const JOBS_DIR = path.join(os.homedir(), '.vscode-terminal-bridge', 'jobs');

const JOB_ID_RE = /^[a-zA-Z0-9._-]+$/;

function jobPaths(jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  return {
    dir,
    log: path.join(dir, 'log'),
    exitCode: path.join(dir, 'exit-code'),
    swept: path.join(dir, 'swept'),
    worktree: path.join(WORKTREES_DIR, jobId),
  };
}

// Single-quote a string for safe interpolation into a shell command.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function listRmuxSessions() {
  try {
    const { stdout } = await execAsync('rmux list-sessions');
    return stdout;
  } catch {
    // Non-zero exit (e.g. no sessions at all) — treat as empty.
    return '';
  }
}

async function sweepWorktree(jobId) {
  const { worktree, swept } = jobPaths(jobId);
  if (fs.existsSync(swept)) return;
  if (!fs.existsSync(worktree)) {
    fs.writeFileSync(swept, '');
    return;
  }
  try {
    await execAsync(`git -C ${shQuote(REPO_DIR)} worktree remove ${shQuote(worktree)}`);
    fs.writeFileSync(swept, '');
  } catch (err) {
    console.error(`[worker] sweep failed for ${jobId}:`, err.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleRunJob(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
    return;
  }

  const { jobId, cmd } = payload;
  const ref = payload.ref || 'main';

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    sendJson(res, 400, { ok: false, error: 'jobId must match [a-zA-Z0-9._-]+' });
    return;
  }
  if (!cmd) {
    sendJson(res, 400, { ok: false, error: 'cmd is required' });
    return;
  }

  const { dir, log, exitCode, worktree } = jobPaths(jobId);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });

    await execAsync(`git -C ${shQuote(REPO_DIR)} fetch origin ${shQuote(ref)}`);
    const { stdout } = await execAsync(`git -C ${shQuote(REPO_DIR)} rev-parse origin/${ref}`);
    const sha = stdout.trim();

    await execAsync(`git -C ${shQuote(REPO_DIR)} worktree add ${shQuote(worktree)} ${shQuote(sha)}`);

    const inner = `cd ${shQuote(worktree)} && { ${cmd} ; } > ${shQuote(log)} 2>&1; echo $? > ${shQuote(exitCode)}`;
    await execAsync(`rmux new-session -d -s ${shQuote(jobId)} bash -lc ${shQuote(inner)}`);

    sendJson(res, 200, { ok: true, jobId, ref, sha });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleJobStatus(req, res, url) {
  const jobId = url.searchParams.get('id');
  const offset = Number(url.searchParams.get('offset')) || 0;

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    sendJson(res, 400, { ok: false, error: 'id must match [a-zA-Z0-9._-]+' });
    return;
  }

  const { log, exitCode: exitCodePath } = jobPaths(jobId);

  const done = fs.existsSync(exitCodePath);
  const code = done ? parseInt(fs.readFileSync(exitCodePath, 'utf8').trim(), 10) : null;

  let running = false;
  if (!done) {
    const sessions = await listRmuxSessions();
    running = sessions.includes(jobId);
  }

  let logChunk = '';
  let nextOffset = offset;
  if (fs.existsSync(log)) {
    const size = fs.statSync(log).size;
    if (size > offset) {
      const fd = fs.openSync(log, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      logChunk = buf.toString('utf8');
      nextOffset = size;
    }
  }

  if (done && code === 0) await sweepWorktree(jobId);

  sendJson(res, 200, { ok: true, done, exitCode: code, running, logChunk, nextOffset });
}

async function handleSweepJob(req, res, url) {
  const jobId = url.searchParams.get('id');
  if (!jobId || !JOB_ID_RE.test(jobId)) {
    sendJson(res, 400, { ok: false, error: 'id must match [a-zA-Z0-9._-]+' });
    return;
  }
  await sweepWorktree(jobId);
  sendJson(res, 200, { ok: true, jobId });
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/run-job') {
    await handleRunJob(req, res);
  } else if (req.method === 'GET' && url.pathname === '/job-status') {
    await handleJobStatus(req, res, url);
  } else if (req.method === 'POST' && url.pathname === '/sweep-job') {
    await handleSweepJob(req, res, url);
  } else if (req.method === 'GET' && url.pathname === '/ping') {
    sendJson(res, 200, { ok: true, port: PORT, hostname: os.hostname() });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[worker] listening on 0.0.0.0:${PORT}, repo=${REPO_DIR}`);
});
