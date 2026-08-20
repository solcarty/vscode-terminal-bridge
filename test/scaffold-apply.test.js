// #47 — `scaffold --backend claude --apply` merges the canonical hooks into a
// settings.json instead of printing them for a hand-merge. The properties that
// make it safe to run against a live install are the whole feature: additive,
// idempotent, and refusing rather than rewriting a file it can't parse.
//
// Pure CLI + filesystem — no bridge involved, so this file doesn't drive the
// HTTP surface and can shell out synchronously.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CTL = path.join(__dirname, '..', 'bin', 'bridgectl.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-scaffold-'));

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const apply = settings =>
  spawnSync('bash', [CTL, 'scaffold', '--backend', 'claude', '--apply', `--settings=${settings}`],
    { encoding: 'utf8' });
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const cmds = (cfg, event) =>
  (cfg.hooks?.[event] ?? []).flatMap(g => (g.hooks ?? []).map(h => h.command));

// 1. A live install: hand-rolled pre-v0.13 hooks, an unrelated setting, and a
//    matcher-scoped group. None of it may be lost or reinterpreted.
const live = path.join(dir, 'live.json');
fs.writeFileSync(live, JSON.stringify({
  model: 'opus',
  permissions: { allow: ['Bash(git:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: "curl -s 'localhost:31415/rename-terminal?status=idle'" }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
  },
}, null, 2));

let r = apply(live);
check('apply exits 0 on a live install', r.status === 0, r.stderr);
let cfg = read(live);

check('unrelated settings survive', cfg.model === 'opus' && cfg.permissions.allow[0] === 'Bash(git:*)', cfg);
check('the existing hand-rolled Stop hook is kept',
  cmds(cfg, 'Stop').some(c => c.includes('rename-terminal')), cmds(cfg, 'Stop'));
check('both scaffolded Stop hooks are appended alongside it',
  cmds(cfg, 'Stop').filter(c => c.includes('hook-status idle') || c.includes('hook-output')).length === 2,
  cmds(cfg, 'Stop'));
check('the matcher-scoped PreToolUse group is left untouched',
  cfg.hooks.PreToolUse[0].matcher === 'Bash' && cfg.hooks.PreToolUse[0].hooks[0].command === 'echo pre',
  cfg.hooks.PreToolUse);
check('the scaffolded PreToolUse hook goes in its own group, inheriting no matcher',
  cfg.hooks.PreToolUse[1].matcher === undefined, cfg.hooks.PreToolUse);
check('all 8 hooks are present after one run',
  ['PreToolUse', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted']
    .flatMap(e => cmds(cfg, e)).filter(c => c.includes('bridgectl.sh')).length === 8, cfg.hooks);
check('the report names what was added, per event',
  (r.stdout.match(/^\s+added\s/gm) || []).length === 8, r.stdout);
check('the previous contents are backed up', fs.existsSync(live + '.bak'), fs.readdirSync(dir));

// 2. Idempotent — the upgrade path has to be re-runnable.
const before = fs.readFileSync(live, 'utf8');
r = apply(live);
check('a second run exits 0', r.status === 0, r.stderr);
check('a second run adds nothing', fs.readFileSync(live, 'utf8') === before, r.stdout);
check('a second run reports already-present for all 8',
  (r.stdout.match(/^\s+already-present\s/gm) || []).length === 8, r.stdout);

// 3. Malformed JSON: refuse. A settings.json that doesn't parse disables every
//    setting in it, so a partial write is worse than no write at all.
const broken = path.join(dir, 'broken.json');
fs.writeFileSync(broken, '{ "hooks": {,,, ');
r = apply(broken);
check('malformed settings → non-zero exit', r.status !== 0, r.status);
check('malformed settings are left byte-for-byte alone',
  fs.readFileSync(broken, 'utf8') === '{ "hooks": {,,, ', fs.readFileSync(broken, 'utf8'));
check('the refusal says why', /not valid JSON/.test(r.stderr), r.stderr);
check('no backup is written for a file we refused', !fs.existsSync(broken + '.bak'), fs.readdirSync(dir));

// 4. A hooks key of the wrong shape is a refusal too, not a silent overwrite.
const wrongShape = path.join(dir, 'wrong.json');
fs.writeFileSync(wrongShape, JSON.stringify({ hooks: { Stop: 'bash something' } }));
r = apply(wrongShape);
check('hooks.<event> that is not an array → refused', r.status !== 0 && /not an array/.test(r.stderr), r.stderr);
check('the wrong-shaped file is untouched', read(wrongShape).hooks.Stop === 'bash something', read(wrongShape));

// 5. Missing file / missing directory: create both, no backup to make.
const fresh = path.join(dir, 'nested', 'deeper', 'settings.json');
r = apply(fresh);
check('a missing settings.json is created', r.status === 0 && fs.existsSync(fresh), r.stderr);
check('the created file has all 8 hooks',
  Object.values(read(fresh).hooks).flatMap(g => g).flatMap(g => g.hooks).length === 8, read(fresh).hooks);
check('no .bak for a file that did not exist', !fs.existsSync(fresh + '.bak'), fs.readdirSync(path.dirname(fresh)));

// 6. Without --apply the printed snippet still works, and says the same thing.
r = spawnSync('bash', [CTL, 'scaffold', '--backend', 'claude', '--dir=/repo'], { encoding: 'utf8' });
check('printing still exits 0', r.status === 0, r.stderr);
const snippet = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
let printed;
try { printed = JSON.parse(snippet); } catch (e) { printed = null; check('the printed snippet is valid JSON', false, e.message); }
if (printed) {
  const printedCmds = Object.values(printed.hooks).flatMap(g => g).flatMap(g => g.hooks).map(h => h.command).sort();
  const appliedCmds = Object.values(read(fresh).hooks).flatMap(g => g).flatMap(g => g.hooks).map(h => h.command).sort();
  check('printed snippet and --apply agree exactly',
    JSON.stringify(printedCmds) === JSON.stringify(appliedCmds), { printedCmds, appliedCmds });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
