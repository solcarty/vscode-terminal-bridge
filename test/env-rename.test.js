// #57 — HH_ORCHESTRATOR_ID / HH_BRIDGE_STATUS_URL renamed to the
// VSCODE_BRIDGE_ prefix, expand/contract: both names must be exported so
// nothing reading the old names breaks before it migrates. Also covers
// terminalBridge.pipelineStateDir, which replaced the hardcoded `.sdo/`.

const h = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
  });
});
const post = (port, p, body) => new Promise(res => {
  const data = JSON.stringify(body);
  const req = http.request({ port, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b })); });
  req.end(data);
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
  const sentLines = name => h.findTerminal(name).sent.map(s => s.text);

  // ── Both old and new env var names are exported ─────────────────────────
  await get(port, '/open-terminal?name=envt&cwd=/tmp/e&cmd=echo%20hi');
  h.fireShellIntegration(h.findTerminal('envt'));
  await wait(20);
  const lines = sentLines('envt');

  check('new orchestrator id var is exported',
    lines.some(l => l.startsWith('export VSCODE_BRIDGE_ORCHESTRATOR_ID=')), lines);
  check('new status url var is exported',
    lines.some(l => l.startsWith('export VSCODE_BRIDGE_STATUS_URL=')), lines);
  check('legacy orchestrator id var is still exported (expand/contract)',
    lines.some(l => l.startsWith('export HH_ORCHESTRATOR_ID=')), lines);
  check('legacy status url var is still exported (expand/contract)',
    lines.some(l => l.startsWith('export HH_BRIDGE_STATUS_URL=')), lines);

  const newId = lines.find(l => l.startsWith('export VSCODE_BRIDGE_ORCHESTRATOR_ID='));
  const oldId = lines.find(l => l.startsWith('export HH_ORCHESTRATOR_ID='));
  check('old and new orchestrator id agree', newId.endsWith('"envt"') && oldId.endsWith('"envt"'),
    { newId, oldId });

  const newUrl = lines.find(l => l.startsWith('export VSCODE_BRIDGE_STATUS_URL='));
  const oldUrl = lines.find(l => l.startsWith('export HH_BRIDGE_STATUS_URL='));
  check('old and new status url agree', newUrl.split('=').slice(1).join('=') === oldUrl.split('=').slice(1).join('='),
    { newUrl, oldUrl });

  // ── .sdo/ default is unchanged when pipelineStateDir isn't configured ───
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-'));
  h.vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: tmp1 } }];

  await post(port, '/api/status', { repo: tmp1, ok: true });
  check('default writes into .sdo/pipeline-state.json',
    fs.existsSync(path.join(tmp1, '.sdo', 'pipeline-state.json')),
    fs.readdirSync(tmp1));

  // ── A configured pipelineStateDir is honored instead ─────────────────────
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-'));
  h.vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: tmp2 } }];
  h.vscodeMock._config.pipelineStateDir = '.custom-state';

  await post(port, '/api/status', { repo: tmp2, ok: true });
  check('configured dir is used instead of .sdo',
    fs.existsSync(path.join(tmp2, '.custom-state', 'pipeline-state.json')),
    fs.readdirSync(tmp2));
  check('.sdo is not also created when a custom dir is configured',
    !fs.existsSync(path.join(tmp2, '.sdo')), fs.readdirSync(tmp2));

  console.log(fails ? `\n${fails} failing` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
