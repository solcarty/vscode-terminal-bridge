// #83 — a window running an older extension deleted the headless bridge's
// port files on dispose, and nothing put them back: the bridge stayed up but
// no caller could find it. The headless bridge now repairs its own discovery
// files on a timer.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requireTmux, startHeadless, killTmuxServer, wait } = require('./headless-helpers');

requireTmux();

const REPAIR_MS = 400;
const get = (port, p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => { b += c; });
    r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  }).on('error', reject);
});
const read = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const repairLines = log => (log.match(/repaired discovery/g) || []).length;

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

(async () => {
  const home = path.join(process.env.HOME, '.vscode-terminal-bridge');
  const bridgesDir = path.join(home, 'bridges');
  const fallback = path.join(home, 'port');
  const a = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'ws-a-')));
  const b = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'ws-b-')));
  const portA = path.join(a, '.vscode-bridge-port');
  const portB = path.join(b, '.vscode-bridge-port');

  const bridge = await startHeadless({ folders: [a, b], env: { VSCODE_BRIDGE_REPAIR_MS: String(REPAIR_MS) } });
  const version = require('../package.json').version;
  try {
    const ping = await get(bridge.port, '/ping');
    check('/ping reports the bridge version', ping.version === version, ping);
    const [entryFile] = fs.readdirSync(bridgesDir);
    const entryPath = path.join(bridgesDir, entryFile);
    check('the presence entry carries the version',
      JSON.parse(fs.readFileSync(entryPath, 'utf8')).version === version, entryFile);

    // A healthy bridge logs nothing about repairs.
    await wait(REPAIR_MS * 3);
    check('a healthy tick logs nothing', repairLines(bridge.log) === 0, bridge.log);

    // What a disposing 0.32 window did, plus another window's port in one folder.
    fs.unlinkSync(portA);
    fs.writeFileSync(portB, '31416');
    fs.unlinkSync(fallback);
    fs.unlinkSync(entryPath);
    await wait(REPAIR_MS * 1.5 + 200);

    check('a removed folder port file is rewritten', read(portA) === bridge.port, read(portA));
    check('a folder port file naming another port is rewritten', read(portB) === bridge.port, read(portB));
    check('the removed fallback port file is rewritten', read(fallback) === bridge.port, read(fallback));
    const entry = (() => { try { return JSON.parse(fs.readFileSync(entryPath, 'utf8')); } catch { return null; } })();
    check('the removed presence entry is rewritten under the same id',
      entry && String(entry.port) === bridge.port && entry.backend === 'tmux', entry);
    check('the repair is logged once', repairLines(bridge.log) === 1, bridge.log);

    await wait(REPAIR_MS * 3);
    check('…and not again on the ticks after it', repairLines(bridge.log) === 1, bridge.log);

    // A presence entry naming another port is wrong too.
    fs.writeFileSync(entryPath, JSON.stringify({ ...entry, port: 1 }));
    await wait(REPAIR_MS * 1.5 + 200);
    check('a presence entry naming another port is rewritten',
      String(JSON.parse(fs.readFileSync(entryPath, 'utf8')).port) === bridge.port, null);
    check('…as a second repair', repairLines(bridge.log) === 2, bridge.log);
  } finally {
    await bridge.stop();
    killTmuxServer();
  }

  // Its own files go on a clean stop, as before.
  check('a stopped bridge removes its own port files', read(portA) === null && read(fallback) === null,
    [read(portA), read(fallback)]);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
