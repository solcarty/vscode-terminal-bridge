// The bridge's HTTP contract, as one suite run against every backend (#77):
// contract-vscode.test.js runs it on the mocked VS Code harness, and
// contract-tmux.test.js on a real headless bridge over tmux. A route or field
// that behaves differently on one of them fails here, which is the point of
// sharing bridge.js — the two entry points must not drift.
//
// `backend` supplies what only it can:
//   kind               'vscode' | 'tmux'
//   port               the bridge's port
//   cwd                a directory to open terminals in
//   afterOpen(name)    anything needed for an open's shell to report ready
//   delivered(name)    resolves to the text the terminal has received so far
const http = require('http');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function runContract(backend) {
  const get = p => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${backend.port}${p}`, r => {
      let b = ''; r.on('data', c => { b += c; });
      r.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* not JSON */ } resolve({ code: r.statusCode, json }); });
    }).on('error', reject);
  });
  const q = encodeURIComponent;
  const list = async () => (await get('/list')).json;
  const row = async name => (await list()).terminals.find(t => t.name === name);
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > end) return v;
      await wait(100);
    }
  };

  let fails = 0;
  const check = (label, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  [${backend.kind}] ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
    if (!cond) fails++;
  };

  // ── ping ──────────────────────────────────────────────────────────────────
  let r = await get('/ping');
  check('ping answers with its backend', r.code === 200 && r.json.ok && r.json.backend === backend.kind, r.json);
  check('ping reports the workspace folders', Array.isArray(r.json.workspaceFolders), r.json);

  // ── open, and open is idempotent by name ──────────────────────────────────
  r = await get(`/open-terminal?name=c1&cwd=${q(backend.cwd)}&cmd=${q('echo contract-open')}`);
  check('open creates', r.code === 200 && r.json.ok && r.json.reused === false && r.json.delivery === 'pending', r.json);
  await backend.afterOpen('c1');
  r = await get(`/open-terminal?name=c1&cwd=${q(backend.cwd)}&cmd=${q('echo again')}`);
  check('a second open reuses the terminal and runs nothing', r.json.reused === true && r.json.delivery === 'skipped-reused', r.json);

  const opened = await until(async () => { const x = await row('c1'); return x && x.cmdDelivery && x.pidAlive === true ? x : null; });
  check('list has the row, live, at its cwd', opened && opened.live === true && opened.cwd === backend.cwd, opened);
  check('pidAlive is true for a live shell', opened && opened.pidAlive === true, opened);
  check('agentAlive is false for a bare shell', opened && opened.agentAlive === false, opened);
  check('the startup command was delivered', opened && ['shell-integration', 'prompt'].includes(opened.cmdDelivery), opened);
  check('createdAt is stamped', opened && typeof opened.createdAt === 'string', opened);
  check('list reports the backend', (await list()).backend === backend.kind, null);
  const sawCmd = await until(async () => (await backend.delivered('c1')).includes('echo contract-open'));
  check('the terminal received the startup command', sawCmd, await backend.delivered('c1'));

  // ── status and heartbeat ──────────────────────────────────────────────────
  r = await get('/rename-terminal?name=c1&status=working');
  check('status=working', r.code === 200 && r.json.ok && r.json.displayStatus === 'working' && r.json.applied === true, r.json);
  const w1 = await row('c1');
  check('status is stored, label carries the codicon', w1.status === 'working' && w1.label === '$(loading~spin) c1', w1);
  await wait(15);
  await get('/rename-terminal?name=c1&status=working');
  const w2 = await row('c1');
  check('a repeated status keeps statusChangedAt', w2.statusChangedAt === w1.statusChangedAt, [w1.statusChangedAt, w2.statusChangedAt]);
  check('a repeated status moves lastHeartbeatAt', w2.lastHeartbeatAt > w1.lastHeartbeatAt, [w1.lastHeartbeatAt, w2.lastHeartbeatAt]);
  r = await get('/rename-terminal?name=nope&status=working');
  check('status on an unknown name is a 404', r.code === 404, r.json);
  r = await get('/heartbeat?name=c1');
  check('heartbeat stamps', r.code === 200 && r.json.lastHeartbeatAt >= w2.lastHeartbeatAt, r.json);

  // ── send ──────────────────────────────────────────────────────────────────
  r = await get(`/send-text?name=c1&text=${q('echo contract-send')}`);
  check('send submits a single line', r.code === 200 && r.json.delivery === 'submitted' && r.json.mode === 'literal', r.json);
  check('lastSendAt is reported', (await row('c1')).lastSendAt === r.json.lastSendAt, r.json);
  const sawSend = await until(async () => (await backend.delivered('c1')).includes('echo contract-send'));
  check('the terminal received the text', sawSend, await backend.delivered('c1'));
  r = await get(`/send-text?name=c1&text=${q('echo para-1\necho para-2')}&submitDelayMs=50`);
  check('a multi-line send goes as one paste', r.json.mode === 'paste' && r.json.delivery === 'submit-unverified', r.json);
  const sawPaste = await until(async () => (await backend.delivered('c1')).includes('echo para-2'));
  check('the terminal received the paste', sawPaste, await backend.delivered('c1'));

  await get('/rename-terminal?name=c1&status=needs-input');
  r = await get(`/send-text?name=c1&text=${q('echo no')}`);
  check('send refuses at needs-input', r.code === 409, r.json);
  r = await get('/nudge-terminal?name=c1');
  check('nudge refuses at needs-input', r.code === 409, r.json);
  r = await get(`/send-text?name=c1&text=${q('echo forced')}&force=1`);
  check('force=1 sends anyway', r.code === 200 && r.json.ok, r.json);
  await get('/rename-terminal?name=c1&status=idle');
  r = await get('/nudge-terminal?name=c1');
  check('nudge sends a bare Enter', r.code === 200 && r.json.delivery === 'nudge', r.json);
  r = await get(`/send-text?name=nope&text=x`);
  check('send to an unknown name is a 404', r.code === 404, r.json);

  // ── note, output, pr, bg-task ─────────────────────────────────────────────
  r = await get(`/set-note?name=c1&text=${q('shipped: pr=1')}`);
  check('set-note', r.code === 200 && r.json.ok, r.json);
  r = await get('/note?name=c1');
  check('note reads back', r.json.note === 'shipped: pr=1', r.json);
  check('list carries noteUpdatedAt, not the body', (await row('c1')).noteUpdatedAt === r.json.noteUpdatedAt && !('note' in (await row('c1'))), null);

  r = await get(`/set-output?name=c1&text=${q('done, PR or split?')}`);
  check('set-output', r.code === 200 && r.json.stored === true, r.json);
  r = await get('/output?name=c1');
  check('output reads back', r.json.outputs.length === 1 && r.json.outputs[0].text === 'done, PR or split?', r.json);

  r = await get(`/set-pr?name=c1&url=${q('https://github.com/o/r/pull/1')}`);
  check('set-pr', r.code === 200 && r.json.prUrl === 'https://github.com/o/r/pull/1', r.json);
  check('list carries prUrl', (await row('c1')).prUrl === 'https://github.com/o/r/pull/1', null);

  r = await get('/bg-task?name=c1&op=start');
  check('bg-task start', r.json.pendingTasks === 1 && r.json.displayStatus === 'bg-task', r.json);
  r = await get('/bg-task?name=c1&op=end');
  check('bg-task end', r.json.pendingTasks === 0 && r.json.status === 'idle', r.json);

  // ── pane read-back: only a backend that can see its terminals offers it ───
  r = await get('/output?name=c1&pane=1');
  if (backend.kind === 'tmux') check('pane=1 returns the screen', r.code === 200 && r.json.pane.includes('contract-send'), r.json);
  else check('pane=1 is a 501 without a read side', r.code === 501 && r.json.backend === backend.kind, r.json);

  // ── forget and close ──────────────────────────────────────────────────────
  await get(`/open-terminal?name=c2&cwd=${q(backend.cwd)}`);
  r = await get('/forget-terminal?name=c2');
  check('forget drops the row', r.code === 200 && r.json.outcome === 'row-removed' && r.json.wasLive === true, r.json);
  check('forget leaves no row', !(await row('c2')), null);

  r = await get('/close-terminal?name=c1');
  check('close disposes a live terminal', r.code === 200 && r.json.outcome === 'closed', r.json);
  check('close removes the row', !(await row('c1')), null);
  r = await get('/close-terminal?name=c1');
  check('close again is not-tracked', r.code === 404 && r.json.outcome === 'not-tracked', r.json);

  r = await get('/no-such-route');
  check('an unknown route is a 404', r.code === 404, r.code);

  return fails;
}

module.exports = { runContract, wait };
