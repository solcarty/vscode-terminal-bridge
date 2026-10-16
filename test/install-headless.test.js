// #77 — the systemd unit the install script renders: restarts forever, never
// takes the tmux sessions down with the bridge, and runs headless.js with the
// folders it was given.
const { spawnSync } = require('child_process');
const path = require('path');

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const script = path.join(__dirname, '..', 'bin', 'install-headless.sh');
const r = spawnSync('bash', [script, '--print-unit', '--folder=/srv/repo', '--agent-id=dev-1'], { encoding: 'utf8' });
const unit = r.stdout;
const app = path.join(process.env.HOME, '.vscode-terminal-bridge', 'headless', 'app');

check('--print-unit renders without installing', r.status === 0, r.stderr);
check('Restart=always', /^Restart=always$/m.test(unit), unit);
check('KillMode=process, so a restart keeps the tmux sessions', /^KillMode=process$/m.test(unit), unit);
check('ExecStart runs the installed headless.js with node by absolute path',
  new RegExp(`^ExecStart=/\\S*node ${app}/headless\\.js `, 'm').test(unit), unit.match(/^ExecStart=.*$/m));
check('…with the folders and agent id it was given',
  /^ExecStart=.* "--folder" "\/srv\/repo" "--agent-id" "dev-1"$/m.test(unit), unit.match(/^ExecStart=.*$/m));
check('PATH is recorded', /^Environment=PATH=\S+/m.test(unit), unit);
check('enabled at boot via default.target', /^WantedBy=default\.target$/m.test(unit), unit);
check('no placeholder left', !/@(NODE|APP|ARGS|PATH)@/.test(unit), unit);

const bad = spawnSync('bash', [script, '--print-unit', '--nope'], { encoding: 'utf8' });
check('an unknown argument is refused', bad.status !== 0 && /unknown argument/.test(bad.stderr), bad.stderr);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
