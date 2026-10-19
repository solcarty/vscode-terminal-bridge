// the same stage contract through a headless bridge, driven with the
// bundled CLI, with the stage list read from the headless config file.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { requireTmux, startHeadless, killTmuxServer, wait } = require('./headless-helpers');

requireTmux();

const get = (port, p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => { b += c; });
    r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  }).on('error', reject);
});
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

(async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HOME, 'ws-stage-')));
  const configPath = path.join(process.env.HOME, '.vscode-terminal-bridge', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ stages: [
    { key: 'build', label: 'Build', codicon: 'tools' },
    { key: 'merged', label: 'Merged', codicon: 'git-merge', terminal: true },
  ] }));

  const bridge = await startHeadless({ folders: [folder] });
  const row = async n => (await get(bridge.port, '/list')).terminals.find(t => t.name === n);
  try {
    check('the config file stage list is served on /list',
      (await get(bridge.port, '/list')).stages.map(s => s.key).join() === 'build,merged', await get(bridge.port, '/list'));

    await bridgectl(folder, 'open', 'stg', folder, 'sleep 60');
    for (let i = 0; i < 50 && !(await row('stg')); i++) await wait(100);

    let r = await bridgectl(folder, 'stage', 'stg', 'build', '--detail', 'step two');
    check('stage set exits 0', r.code === 0, r);
    let t = await row('stg');
    check('/list reads it back', t.stage === 'build' && t.stageDetail === 'step two' && !!t.stageChangedAt, t);

    r = await bridgectl(folder, 'stage', 'stg', '--clear');
    t = await row('stg');
    check('stage --clear nulls it', r.code === 0 && t.stage === null && t.stageChangedAt === null, [r, t]);

    r = await bridgectl(folder, 'stage', 'ghost', 'build');
    check('an unknown terminal exits 1', r.code === 1, r);
    r = await bridgectl(folder, 'stage', 'stg');
    check('usage error exits 2', r.code === 2, r);

    fs.writeFileSync(configPath, JSON.stringify({ stages: [] }));
    check('an edited config applies without a restart', (await get(bridge.port, '/list')).stages.length === 0, null);
  } finally {
    await bridge.stop();
    killTmuxServer();
  }
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
