// #82 — the idle nudge kept landing as `needs-input` even though the #51
// downgrade matched. Captured from Claude Code 2.1.302: after every turn it
// runs a prompt-suggestion fork that fires `SubagentStop` (agent_type "", no
// SubagentStart) about a second AFTER the main `Stop`. Wired as
// `SubagentStop → hook-status working`, that wrote `working` and armed a fresh
// turn-start mark after the Stop's handoff had cleared it. Sixty seconds later
// the nudge was downgraded to `idle`, and the house.health#4589 guard saw a
// turn with no note and promoted it straight back to `needs-input`.
//
// A SubagentStop now only restores `working` inside a turn that is still
// running (last tracked state `working`/`subagent`). Everywhere else it is a
// no-op — which also stops a late background subagent from overwriting a
// `permission` prompt. Every payload below is a real capture.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SH = path.join(__dirname, '..', 'bin', 'vscode-bridge.sh');
const fixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-hooks', f), 'utf8');

// Same shape as test/idle-note-guard.test.js: a stubbed bridge, a stubbed
// /note (no note ever set), and the on-disk turn-state mark under the
// throwaway $HOME test/run.js provides, persisting across calls.
const hookStatus = (state, payload = '') => {
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(SH)}
     bridge_status() { echo "STATE:$2"; }
     curl() { echo '{"ok":true,"name":"testtab","note":null,"noteUpdatedAt":null}'; }
     bridge_hook_status ${state} --name=testtab`,
  ], { input: payload, encoding: 'utf8' });
  const m = (r.stdout || '').match(/STATE:(\S+)/);
  return m ? m[1] : null; // null = no status written
};

const turnStateFile = path.join(process.env.HOME, '.vscode-terminal-bridge', 'turn-state', 'testtab');
const reset = () => fs.rmSync(turnStateFile, { force: true });

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// The incident: a turn, its Stop with a handoff, the suggestion fork's late
// SubagentStop, then the 60s nudge.
reset();
hookStatus('working', '{"hook_event_name":"PreToolUse"}');
let got = hookStatus('idle', fixture('stop.json'));
check('Stop with a handoff writes idle', got === 'stopped', got);
got = hookStatus('working', fixture('subagent-stop-after-stop.json'));
check('SubagentStop after Stop writes nothing', got === null, got);
got = hookStatus('needs-input', fixture('notification-idle-prompt.json'));
check('the idle nudge after that lands as idle', got === 'stopped', got);

// A real subagent inside a running turn still flips the tab back to working.
reset();
hookStatus('working', '{"hook_event_name":"PreToolUse"}');
hookStatus('subagent', '{"hook_event_name":"SubagentStart"}');
got = hookStatus('working', fixture('subagent-stop-task.json'));
check('SubagentStop after subagent writes working', got === 'working', got);

// A background subagent ending while a permission prompt is up (captured:
// PermissionRequest, then SubagentStop a second later) must not hide it.
reset();
hookStatus('working', '{"hook_event_name":"PreToolUse"}');
hookStatus('permission', '{"hook_event_name":"PermissionRequest"}');
got = hookStatus('working', fixture('subagent-stop-task.json'));
check('SubagentStop during a permission prompt writes nothing', got === null, got);
got = hookStatus('needs-input', fixture('notification-permission-prompt.json'));
check('the permission notification still asserts needs-input', got === 'needs-you', got);

// With no turn-state at all, a SubagentStop can't tell whether a turn is
// running, so it leaves the status alone rather than claim `working`.
reset();
got = hookStatus('working', fixture('subagent-stop-task.json'));
check('SubagentStop with no tracked state writes nothing', got === null, got);

// The #4589 guard still bites when a turn really ended without a handoff:
// the nudge re-asserts needs-input.
reset();
hookStatus('working', '{"hook_event_name":"PreToolUse"}');
got = hookStatus('idle', '{"hook_event_name":"Stop","last_assistant_message":""}');
check('Stop with no handoff and no note is promoted', got === 'blocked', got);
hookStatus('working', fixture('subagent-stop-after-stop.json'));
got = hookStatus('needs-input', fixture('notification-idle-prompt.json'));
check('the nudge after an un-handed-off turn stays needs-input', got === 'blocked', got);

// A PreToolUse is never a SubagentStop, whatever the previous state.
reset();
hookStatus('idle', fixture('stop.json'));
got = hookStatus('working', '{"hook_event_name":"PreToolUse"}');
check('PreToolUse after Stop still writes working', got === 'working', got);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
