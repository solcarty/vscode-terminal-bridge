// #38 — a worker publishes a short handoff; the orchestrator reads it. /list
// carries the timestamp only, never the bodies.
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'terminalBridgeMetadata';
h.state.set(KEY, {
  'worker': { cwd: '/tmp/w', status: 'working', baseLabel: 'worker', label: 'worker' },
  'quiet':  { cwd: '/tmp/q', status: 'idle', baseLabel: 'quiet', label: 'quiet' },
});
h.addTerminal(h.makeTerminal('worker'));
h.addTerminal(h.makeTerminal('quiet'));

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
  const list = async () => JSON.parse((await get(port, '/list')).body).terminals;
  const row = async name => (await list()).find(t => t.name === name);

  check('no note → noteUpdatedAt null', (await row('worker')).noteUpdatedAt === null, await row('worker'));

  // ── set + get ────────────────────────────────────────────────────────────
  const receipt = 'state: done\nshipped: pr=44 branch=feat/x sha=abc123\ntouched: env=shared-dev mutations=1 row';
  let r = await get(port, `/set-note?name=worker&text=${encodeURIComponent(receipt)}`);
  let j = JSON.parse(r.body);
  check('set-note → 200 with a timestamp', r.code === 200 && typeof j.noteUpdatedAt === 'string', j);
  check('set-note reports bytes and truncation', j.bytes === Buffer.byteLength(receipt) && j.truncated === false, j);

  j = JSON.parse((await get(port, '/note?name=worker')).body);
  check('note round-trips verbatim, newlines intact', j.note === receipt, j);
  check('note reports its own timestamp', typeof j.noteUpdatedAt === 'string', j);

  // ── /list carries the timestamp, never the body ──────────────────────────
  const listed = await row('worker');
  check('list exposes noteUpdatedAt', typeof listed.noteUpdatedAt === 'string', listed);
  check('list exposes noteBytes', listed.noteBytes === Buffer.byteLength(receipt), listed);
  check('list does NOT inline the note body', !('note' in listed), listed);
  check('list body never contains the note text',
    !JSON.stringify(await list()).includes('shared-dev'), 'note text leaked into /list');

  // ── publishing a note counts as liveness ─────────────────────────────────
  const hbBefore = (await row('quiet')).lastHeartbeatAt;
  await wait(5);
  await get(port, '/set-note?name=quiet&text=alive');
  check('set-note stamps a heartbeat', (await row('quiet')).lastHeartbeatAt !== hbBefore, await row('quiet'));

  // ── textFile= mirrors /send-text's shape ─────────────────────────────────
  const f = path.join(os.tmpdir(), 'bridge-note-test.md');
  fs.writeFileSync(f, 'state: blocked\nneeds-decision: split the PR or not\n');
  await get(port, `/set-note?name=worker&textFile=${encodeURIComponent(f)}`);
  j = JSON.parse((await get(port, '/note?name=worker')).body);
  check('textFile= injects file contents', j.note.includes('needs-decision'), j);
  r = await get(port, '/set-note?name=worker&textFile=/nope/missing.md');
  check('unreadable textFile → 400', r.code === 400, r.body);
  fs.unlinkSync(f);

  // ── oversized notes are truncated, and say so ────────────────────────────
  const huge = 'x'.repeat(9000);
  j = JSON.parse((await get(port, `/set-note?name=worker&text=${encodeURIComponent(huge)}`)).body);
  check('oversized note reports truncated:true', j.truncated === true, j);
  check('oversized note is capped at maxBytes', j.bytes === j.maxBytes && j.maxBytes === 4096, j);
  j = JSON.parse((await get(port, '/note?name=worker')).body);
  check('stored note is the capped body', Buffer.byteLength(j.note) === 4096 && j.truncated === true, { bytes: Buffer.byteLength(j.note) });
  check('list reports noteTruncated', (await row('worker')).noteTruncated === true, await row('worker'));

  // a multi-byte character must not be cut in half
  await get(port, `/set-note?name=worker&text=${encodeURIComponent('é'.repeat(4000))}`);
  j = JSON.parse((await get(port, '/note?name=worker')).body);
  check('truncation lands on a character boundary', !j.note.includes('�'), j.note.slice(-4));

  // ── clear ────────────────────────────────────────────────────────────────
  r = await get(port, '/clear-note?name=worker');
  check('clear-note → 200', r.code === 200, r.body);
  j = JSON.parse((await get(port, '/note?name=worker')).body);
  check('cleared note reads null', j.note === null && j.noteUpdatedAt === null, j);
  check('cleared note clears list timestamp', (await row('worker')).noteUpdatedAt === null, await row('worker'));

  // ── survives a window reload ─────────────────────────────────────────────
  // A reload is exactly when context is lost, so a note that evaporates then
  // is worth much less. Notes live in workspaceState, which persists — assert
  // the note is readable from the persisted store, not just from memory.
  await get(port, '/set-note?name=worker&text=survives');
  const persisted = h.state.get(KEY)['worker'];
  check('note is written to persisted workspaceState',
    persisted.note === 'survives' && typeof persisted.noteUpdatedAt === 'string', persisted);

  // ── validation ───────────────────────────────────────────────────────────
  r = await get(port, '/set-note?name=nope&text=hi');
  check('set-note on unknown name → 404', r.code === 404, r.body);
  r = await get(port, '/note?name=nope');
  check('note on unknown name → 404', r.code === 404, r.body);
  r = await get(port, '/set-note?name=worker');
  check('set-note with no text → 400', r.code === 400, r.body);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
