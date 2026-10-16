// What only the headless bridge does (#77): discovery files, the bundled CLI
// against it, agentAlive for a tmux pane running `claude`, sessions that
// outlive the bridge, and no fabricated rows after the tmux server is gone (a
// reboot).
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requireTmux, startHeadless, killTmuxServer, tmux, wait } = require('./headless-helpers');

requireTmux();

const get = (port, p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => { b += c; });
    r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  }).on('error', reject);
});
const q = encodeURIComponent;

// The installed CLI, run the way an agent shell on the host would: from inside
// the workspace folder, with no VS Code in its environment. Async, because
// the bridge answering it is a separate process but its output is awaited.
function bridgectl(cwd, ...args) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.TERM_PROGRAM;
    delete env.VSCODE_BRIDGE_PORT;
    const child = spawn('bash', [path.join(process.env.HOME, '.vscode-terminal-bridge', 'bin', 'bridgectl.sh'), ...args], { cwd, env });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    child.on('close', code => resolve({ code, out }));
  });
}

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await wait(150);
  }
};

(async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'ws-')));
  // A stand-in agent: its command line contains `claude`, which is all
  // agentAlive's child-process check looks for.
  const stub = path.join(folder, 'claude-stub.sh');
  fs.writeFileSync(stub, 'sleep 60\n');

  let bridge = await startHeadless({ folders: [folder] });
  const row = async name => (await get(bridge.port, '/list')).terminals.find(t => t.name === name);
  try {
    // ── Discovery: the same files the extension writes ──────────────────────
    const home = path.join(process.env.HOME, '.vscode-terminal-bridge');
    check('the folder gets .vscode-bridge-port',
      fs.readFileSync(path.join(folder, '.vscode-bridge-port'), 'utf8').trim() === bridge.port, null);
    check('the bundled CLI is installed', fs.existsSync(path.join(home, 'bin', 'bridgectl.sh')), null);
    const entries = fs.readdirSync(path.join(home, 'bridges'))
      .map(f => JSON.parse(fs.readFileSync(path.join(home, 'bridges', f), 'utf8')));
    check('the presence entry says backend tmux', entries.length === 1 && entries[0].backend === 'tmux'
      && String(entries[0].port) === bridge.port, entries);

    // ── bridgectl against it ────────────────────────────────────────────────
    let r = await bridgectl(folder, 'open', 'cli.one', folder, 'echo from-cli');
    check('bridgectl open', r.code === 0, r);
    r = await bridgectl(folder, 'status', 'cli.one', 'working');
    check('bridgectl status', r.code === 0, r);
    r = await bridgectl(folder, 'rename', 'cli.one', 'cli.one · step 2');
    check('bridgectl rename', r.code === 0, r);
    r = await bridgectl(folder, 'send', 'cli.one', 'echo sent-by-cli');
    check('bridgectl send', r.code === 0, r);
    r = await bridgectl('/', 'list');
    let listed = null;
    try { listed = JSON.parse(r.out).terminals.find(t => t.name === 'cli.one'); } catch { /* not JSON */ }
    check('bridgectl list, from outside the folder, shows the row', r.code === 0 && listed && listed.status === 'working'
      && listed.tmuxSession === 'cli_one', r.out);
    const ran = await until(async () => {
      const p = await get(bridge.port, '/output?name=cli.one&pane=1&lines=200');
      return p.ok && /^sent-by-cli$/m.test(p.pane) && /^from-cli$/m.test(p.pane) ? p : null;
    });
    check('the open command and the send both ran in the pane', !!ran, await get(bridge.port, '/output?name=cli.one&pane=1'));
    check('the real name survives in @bridge_name',
      tmux('show-options', '-v', '-t', '=cli_one:', '@bridge_name').stdout.trim() === 'cli.one', null);

    // ── agentAlive for a pane running claude ────────────────────────────────
    await get(bridge.port, `/open-terminal?name=agent&cwd=${q(folder)}&cmd=${q(`bash ${stub}`)}`);
    const agent = await until(async () => { const x = await row('agent'); return x && x.agentAlive === true ? x : null; });
    check('agentAlive is true while claude runs under the shell', agent && agent.pidAlive === true, await row('agent'));
    tmux('send-keys', '-t', '=agent:', 'C-c', '');
    const bare = await until(async () => { const x = await row('agent'); return x && x.agentAlive === false ? x : null; });
    check('agentAlive is false once it exits back to the shell', bare && bare.pidAlive === true, await row('agent'));

    // ── A session that ends takes its row with it, as a closed tab does ─────
    await get(bridge.port, `/open-terminal?name=brief&cwd=${q(folder)}`);
    await until(async () => (await row('brief'))?.pid);
    tmux('kill-session', '-t', '=brief');
    check('a session that ends drops its row', await until(async () => !(await row('brief'))), await row('brief'));

    // ── Restart: sessions outlive the bridge and are reattached ─────────────
    const before = await row('cli.one');
    await bridge.stop();
    check('stopping the bridge leaves the sessions running',
      tmux('has-session', '-t', '=cli_one').status === 0, null);
    bridge = await startHeadless({ folders: [folder] });
    const after = await row('cli.one');
    check('after a restart the row is back, live, on the same session',
      after && after.live === true && after.tmuxSession === 'cli_one' && after.pid === before.pid
      && after.createdAt === before.createdAt && after.status === 'working', after);
    const sent = await get(bridge.port, `/send-text?name=cli.one&text=${q('echo after-restart')}`);
    check('send works after a restart', sent.ok && sent.delivery === 'submitted', sent);
    check('…and lands in the pane', !!(await until(async () =>
      /^after-restart$/m.test((await get(bridge.port, '/output?name=cli.one&pane=1&lines=200')).pane))), null);

    // ── Reboot: the tmux server is gone, so are its terminals ───────────────
    await bridge.stop();
    killTmuxServer();
    bridge = await startHeadless({ folders: [folder] });
    const rows = (await get(bridge.port, '/list')).terminals;
    check('after the tmux server is gone, list has no rows', rows.length === 0, rows.map(t => t.name));
    check('…and the bridge says why', /dropped \d+ row\(s\) whose tmux session is gone/.test(bridge.log), bridge.log);
  } catch (err) {
    console.log(`FAIL  ${err.stack}`);
    fails++;
  } finally {
    await bridge.stop();
    killTmuxServer();
  }
  if (fails) console.log(`\nheadless log:\n${bridge.log}`);
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
