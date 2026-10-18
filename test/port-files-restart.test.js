// #91 — a restarted bridge listens on the SAME port as the instance it
// replaces, so an old instance's shutdown must not delete files the new one
// wrote. Ownership is "this instance wrote it and nobody has since", not
// "it holds my port". Also: the shell helper doesn't call a bridge unreachable
// just because every port file is gone.
const h = require('./harness');
const bridge = require('../bridge');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const wait = ms => new Promise(r => setTimeout(r, ms));
const read = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

(async () => {
  const ws = fs.mkdtempSync(path.join(process.env.HOME, 'ws-restart-'));
  const folderFile = path.join(ws, '.vscode-bridge-port');
  h.vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];

  // Instance A (the one shutting down).
  await h.ext.activate(h.context);
  let port = null;
  for (let i = 0; i < 50 && !port; i++) { await wait(50); port = read(h.portFile); }
  check('instance A wrote its port files', port && read(folderFile) === port, port);

  // Instance B starts on the same port and writes its files (A's cleanup has
  // not run yet). Same content, new write.
  await wait(20);
  bridge.writePortFiles([ws], port);

  for (const sub of h.context.subscriptions) { try { sub.dispose(); } catch { /* best effort */ } }

  check("A's shutdown leaves B's workspace port file", read(folderFile) === port, read(folderFile));
  check("A's shutdown leaves B's fallback port file", read(h.portFile) === port, read(h.portFile));

  // The shell helper: no files, but the port answers /ping.
  const home = fs.mkdtempSync(path.join(process.env.HOME, 'home-empty-'));
  const probe = curlBody => spawnSync('bash', ['-c', `
    unset TERM_PROGRAM VSCODE_BRIDGE_PORT
    curl() { ${curlBody}; }
    . "${path.join(__dirname, '..', 'bin', 'vscode-bridge.sh')}"
    cd /; _bridge_active`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }).status;
  check('no port files but /ping answers: bridge is active', probe(`echo '{"ok":true,"port":31415}'`) === 0);
  check('no port files and nothing answers: bridge is not active', probe('return 22') === 1);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
