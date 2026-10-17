// #77 — a window opening on a host whose headless bridge is already up does not
// start a second bridge. It shows the headless terminals in its Terminals
// panel, and a click attaches a VS Code terminal to the tmux session.
//
// The headless bridge here is a stand-in HTTP server answering /ping and /list
// the way headless.js does, so this runs without tmux.
process.env.VSCODE_BRIDGE_VIEWER_POLL_MS = '100';
const h = require('./harness');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { VIEW_ID, SHOW_COMMAND } = require('../panel');

const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

function fakeBridge(backend, terminals = [], version) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(url.pathname);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/ping') res.end(JSON.stringify({ ok: true, backend, version, tmuxSocket: 'vscode-bridge', pid: process.pid }));
    else if (url.pathname === '/list') res.end(JSON.stringify({ ok: true, backend, terminals }));
    else res.end(JSON.stringify({ ok: false }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

(async () => {
  const home = path.join(process.env.HOME, '.vscode-terminal-bridge');
  const bridgesDir = path.join(home, 'bridges');
  fs.mkdirSync(bridgesDir, { recursive: true });
  const folder = fs.mkdtempSync(path.join(process.env.HOME, 'ws-'));
  h.vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: folder } }];

  const headless = await fakeBridge('tmux', [
    { name: 'feat-1', status: 'working', live: true, tmuxSession: 'feat-1', createdAt: '2026-10-16T10:00:00Z' },
    { name: 'gone', status: 'idle', live: false, tmuxSession: null, createdAt: '2026-10-16T09:00:00Z' },
  ], '0.0.1');
  fs.writeFileSync(h.portFile, String(headless.port));
  fs.writeFileSync(path.join(bridgesDir, 'headless.json'),
    JSON.stringify({ id: 'headless', port: headless.port, pid: process.pid, backend: 'tmux' }));

  await h.ext.activate(h.context);
  await wait(400);

  // ── No second bridge ────────────────────────────────────────────────────
  check('the window did not start a server: no presence entry of its own',
    fs.readdirSync(bridgesDir).length === 1, fs.readdirSync(bridgesDir));
  check('the port file still points at the headless bridge',
    fs.readFileSync(h.portFile, 'utf8').trim() === String(headless.port), fs.readFileSync(h.portFile, 'utf8'));
  check('the workspace folder gets the headless port',
    fs.readFileSync(path.join(folder, '.vscode-bridge-port'), 'utf8').trim() === String(headless.port), null);
  check('the window polls the headless /list', headless.hits.includes('/list'), headless.hits);

  // ── The panel shows the headless terminals ──────────────────────────────
  const view = h.treeViews.find(v => v.id === VIEW_ID);
  const provider = view.options.treeDataProvider;
  const items = provider.getChildren().map(e => provider.getTreeItem(e));
  check('the panel lists the live headless rows only', items.map(i => i.label).join() === 'feat-1', items.map(i => i.label));
  check('the row carries its status icon', items[0]?.iconPath?.id === 'loading~spin', items[0]?.iconPath);
  check('the view says it is showing a headless bridge', /headless/.test(view.description || ''), view.description);
  // #83 — an out-of-date window is visible.
  const own = require('../package.json').version;
  check('a version mismatch shows both versions in the view description',
    (view.description || '').includes('v0.0.1') && (view.description || '').includes(`v${own}`), view.description);

  // ── A click attaches to the session ─────────────────────────────────────
  await h.vscodeMock.commands.executeCommand(SHOW_COMMAND, 'feat-1');
  const attached = h.findTerminal('feat-1');
  check('a click opens a terminal running tmux attach',
    attached && attached.options.shellPath === 'tmux'
    && JSON.stringify(attached.options.shellArgs) === JSON.stringify(['-L', 'vscode-bridge', 'attach-session', '-t', '=feat-1']),
    attached && attached.options);
  check('…and shows it', attached && attached.shows === 1, attached && attached.shows);
  await h.vscodeMock.commands.executeCommand(SHOW_COMMAND, 'feat-1');
  check('a second click reuses that terminal', h.countTerminals('feat-1') === 1 && attached.shows === 2, h.countTerminals('feat-1'));

  // ── Only a live headless bridge is deferred to ──────────────────────────
  const other = await fakeBridge('vscode');
  fs.unlinkSync(path.join(bridgesDir, 'headless.json'));
  fs.writeFileSync(h.portFile, String(other.port));
  check('a port file pointing at another VS Code window is not a headless bridge',
    (await h.ext.findHeadlessBridge()) === null, null);
  headless.server.close();
  fs.writeFileSync(h.portFile, String(headless.port));
  check('a headless bridge that does not answer is not deferred to', (await h.ext.findHeadlessBridge()) === null, null);
  const found = await (async () => {
    const back = await fakeBridge('tmux');
    fs.writeFileSync(path.join(bridgesDir, 'back.json'), JSON.stringify({ port: back.port, pid: process.pid, backend: 'tmux' }));
    return h.ext.findHeadlessBridge().then(r => { back.server.close(); return r; });
  })();
  check('a presence entry with backend tmux is found even when the port file points elsewhere',
    found && found.backend === 'tmux', found);

  other.server.close();
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
