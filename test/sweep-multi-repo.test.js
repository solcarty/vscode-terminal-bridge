// #87 — a bridge restart, or any sweep, never kills a live worker.
//
// Workspace folders are repo A and a bare `B-worktrees` root (the headless
// layout: a -worktrees root is not a git repo itself). Rows sit in worktrees
// of both repos, in a directory that exists but no repo lists, in a removed
// directory, and in a removed directory whose shell still runs a process.
// Before #87 the startup sweep read only the first folder's repo, so all but
// repo A's row were swept, the busy shell included.
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn, spawnSync } = require('child_process');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sweep-')));
const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' });
for (const repo of ['A', 'B']) {
  const dir = path.join(root, repo);
  fs.mkdirSync(dir);
  git(dir, 'init -q -b main');
  git(dir, '-c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
  fs.mkdirSync(path.join(root, `${repo}-worktrees`));
  git(dir, `worktree add -q ../${repo}-worktrees/w${repo} -b w${repo}`);
}
const unlisted = path.join(root, 'unlisted');
fs.mkdirSync(unlisted);
const removed = path.join(root, 'B-worktrees', 'gone');
const removedBusy = path.join(root, 'A-worktrees', 'gone-busy');
const removedIdle = path.join(root, 'A-worktrees', 'gone-idle');
const removedNoPid = path.join(root, 'A-worktrees', 'gone-nopid');

// A pid that is certainly dead, and a shell that still runs a child.
const deadPid = spawnSync('true').pid;
const busyShell = spawn('bash', ['-c', 'sleep 30; :'], { stdio: 'ignore' });
// #90 — a live process with no children at all (an idle shell at its prompt).
const idleShell = spawn('sleep', ['30'], { stdio: 'ignore' });

h.vscodeMock.workspace.workspaceFolders = [path.join(root, 'A'), path.join(root, 'B-worktrees')]
  .map(fsPath => ({ uri: { fsPath } }));

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'repo-a':    { cwd: path.join(root, 'A-worktrees', 'wA'), status: 'working' },
  'repo-b':    { cwd: path.join(root, 'B-worktrees', 'wB'), status: 'working' },
  'unlisted':  { cwd: unlisted, status: 'working' },
  'gone':      { cwd: removed, status: 'idle', pid: deadPid },
  'gone-busy': { cwd: removedBusy, status: 'working', pid: busyShell.pid },
  'gone-idle': { cwd: removedIdle, status: 'idle', pid: idleShell.pid },
  'gone-nopid': { cwd: removedNoPid, status: 'idle' },
});
for (const [name, pid] of [['repo-a', deadPid], ['repo-b', deadPid], ['unlisted', deadPid], ['gone', deadPid]]) {
  h.addTerminal(h.makeTerminal(name, pid));
}

h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
  });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const sorted = a => [...a].sort().join(',');

(async () => {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    try { port = fs.readFileSync(h.portFile, 'utf8').trim(); } catch { /* not up yet */ }
  }
  if (!port) { console.log('FAIL  bridge never wrote a port file'); process.exit(1); }

  // The startup sweep fires at 2.5s. Let it run, then confirm it closed nothing.
  await wait(3500);
  check(h.disposed.length === 0, `startup sweep disposes nothing (disposed: ${h.disposed.join(',') || 'none'})`);
  check(Object.keys(h.state.get(KEY)).length === 7, 'startup sweep drops no registry row');

  const dry = await get(port, '/sweep?dryRun=1');
  check(dry.dryRun === true && sorted(dry.wouldClose) === 'gone',
    `dry run would close only the removed dir (got ${JSON.stringify(dry.wouldClose)})`);
  check(h.disposed.length === 0 && Object.keys(h.state.get(KEY)).length === 7, 'dry run closes nothing');

  const real = await get(port, '/sweep');
  check(sorted(real.closed) === 'gone', `sweep closes only the removed dir (got ${JSON.stringify(real.closed)})`);
  check(sorted(h.disposed) === 'gone', `only the removed dir's terminal is disposed (got ${h.disposed.join(',')})`);
  const rows = h.state.get(KEY);
  check(!!rows['repo-b'], 'a worktree of another repo (reached via its -worktrees root) is kept');
  check(!!rows['repo-a'], "a worktree of the first folder's repo is kept");
  check(!!rows['unlisted'], 'a cwd that exists but no repo lists is kept');
  check(!!rows['gone-busy'], 'a removed cwd whose shell still runs a process is kept');
  check(!!rows['gone-idle'], '#90: a removed cwd whose process is alive but idle is kept');
  check(!!rows['gone-nopid'], '#90: a removed cwd whose pid is unknown is kept (unknown is not dead)');
  check(isAlive(busyShell.pid) && isAlive(idleShell.pid), 'live processes were not signalled');

  busyShell.kill('SIGKILL');
  idleShell.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
