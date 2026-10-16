// The shared contract (test/contract.js) against the tmux backend: a real
// headless.js process driving real tmux sessions.
const fs = require('fs');
const path = require('path');
const { runContract } = require('./contract');
const { requireTmux, startHeadless, killTmuxServer, tmux } = require('./headless-helpers');

requireTmux();

(async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'cwd-')));
  let bridge;
  let fails = 0;
  try {
    bridge = await startHeadless({ folders: [cwd] });
    fails = await runContract({
      kind: 'tmux',
      port: bridge.port,
      cwd,
      afterOpen: async () => {},
      // What the pane shows: typed input echoes there, so a delivered command
      // is visible whether or not it has run yet.
      delivered: async name => {
        const row = JSON.parse(await fetchText(`http://127.0.0.1:${bridge.port}/list`))
          .terminals.find(t => t.name === name);
        if (!row?.tmuxSession) return '';
        const r = tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', `=${row.tmuxSession}:`);
        return r.stdout || '';
      },
    });
  } catch (err) {
    console.log(`FAIL  ${err.stack}`);
    fails++;
  } finally {
    if (bridge) await bridge.stop();
    killTmuxServer();
  }
  if (fails && bridge) console.log(`\nheadless log:\n${bridge.log}`);
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();

function fetchText(url) {
  return new Promise((resolve, reject) => {
    require('http').get(url, r => { let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve(b)); }).on('error', reject);
  });
}
