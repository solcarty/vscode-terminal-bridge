// #83 — a disposing extension removes only the port files that still hold its
// own port. A 0.32 window on a headless host deleted the headless bridge's
// files on dispose and left it undiscoverable.
const h = require('./harness');
const fs = require('fs');
const path = require('path');

const wait = ms => new Promise(r => setTimeout(r, ms));
const read = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

(async () => {
  const mine = fs.mkdtempSync(path.join(process.env.HOME, 'ws-mine-'));
  const theirs = fs.mkdtempSync(path.join(process.env.HOME, 'ws-theirs-'));
  h.vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: mine } }, { uri: { fsPath: theirs } }];

  await h.ext.activate(h.context);
  let own = null;
  for (let i = 0; i < 50 && !own; i++) { await wait(50); own = read(h.portFile); }
  check('the window wrote its port files', own && read(path.join(theirs, '.vscode-bridge-port')) === own, own);

  // Another bridge (the headless one) has since written its port here and in
  // the fallback.
  fs.writeFileSync(path.join(theirs, '.vscode-bridge-port'), '31415');
  fs.writeFileSync(h.portFile, '31415');

  for (const sub of h.context.subscriptions) { try { sub.dispose(); } catch { /* best effort */ } }

  check('a folder port file holding its own port is removed', read(path.join(mine, '.vscode-bridge-port')) === null,
    read(path.join(mine, '.vscode-bridge-port')));
  check('a folder port file holding another port is left', read(path.join(theirs, '.vscode-bridge-port')) === '31415',
    read(path.join(theirs, '.vscode-bridge-port')));
  check('the fallback port file holding another port is left', read(h.portFile) === '31415', read(h.portFile));

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
