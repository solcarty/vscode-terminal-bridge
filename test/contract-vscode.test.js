// The shared contract (test/contract.js) against the VS Code backend.
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { runContract, wait } = require('./contract');

// A live pid, so pidAlive reads true the way a real shell's would.
h.vscodeMock._createPid = process.pid;
h.ext.activate(h.context);

(async () => {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    try { port = fs.readFileSync(h.portFile, 'utf8').trim(); } catch { /* not up yet */ }
  }
  if (!port) { console.log('FAIL  bridge never wrote a port file'); process.exit(1); }

  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'cwd-')));
  const fails = await runContract({
    kind: 'vscode',
    port,
    cwd,
    afterOpen: async name => { h.fireShellIntegration(h.findTerminal(name)); await wait(20); },
    // Every sendText the mock terminal received, as the shell would see it.
    delivered: async name => (h.findTerminal(name)?.sent ?? [])
      .map(s => s.text + (s.submit === false ? '' : '\n')).join(''),
  });

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
