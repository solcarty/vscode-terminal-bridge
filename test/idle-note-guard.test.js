// house.health#4589 — two 2026-09-09 sessions ended a turn `idle` with no
// note (the second one after an explicit instruction not to), and real
// findings were nearly lost both times. A prompt-level instruction was
// proven not to hold, so the guarantee moved into bridge_hook_status: a
// Stop hook asking for `idle` is compared against a local "when did this
// turn start" mark and the terminal's own noteUpdatedAt, and promoted to
// `needs-input` when the note doesn't cover the turn. These cases are the
// contract; see the guard's own comment in bin/vscode-bridge.sh.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SH = path.join(__dirname, '..', 'bin', 'vscode-bridge.sh');

// Each call is its own process, but they share $HOME (the throwaway dir
// test/run.js hands this file), so the on-disk turn-state mark persists
// across the sequence the way it would across real hook invocations.
const hookStatus = (state, { note = null, curlFails = false } = {}) => {
  const curlStub = curlFails
    ? `curl() { return 1; }`
    : note === null
      ? `curl() { echo '{"ok":true,"name":"testtab","note":null,"noteUpdatedAt":null}'; }`
      : `curl() { echo '{"ok":true,"name":"testtab","note":"x","noteUpdatedAt":"${note}"}'; }`;
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(SH)}
     bridge_status() { echo "STATE:$2"; }
     ${curlStub}
     bridge_hook_status ${state} --name=testtab`,
  ], { encoding: 'utf8' });
  const m = (r.stdout || '').match(/STATE:(\S+)/);
  return m ? m[1] : `<no decision: stdout=${r.stdout} stderr=${r.stderr}>`;
};

const turnStateFile = () => path.join(process.env.HOME, '.vscode-terminal-bridge', 'turn-state', 'testtab');
const resetTurnState = () => fs.rmSync(turnStateFile(), { force: true });

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// No turn-start mark at all (first call this test has ever seen for this
// name) — the guard can't know a turn boundary, so it fails open and idle
// is left alone rather than guessing.
resetTurnState();
let got = hookStatus('idle', { note: null });
check('idle with no turn-start mark at all is left alone (fails open)', got === 'idle', got);

// A working turn starts, then Stop asks for idle with no note ever set —
// the exact shape of both 2026-09-09 incidents.
resetTurnState();
hookStatus('working', { note: null });
got = hookStatus('idle', { note: null });
check('idle after a working turn with NO note is promoted to needs-input', got === 'needs-input', got);

// A working turn starts, then Stop asks for idle with a note that predates
// the turn (stale — written by some earlier turn, never updated for this one).
resetTurnState();
hookStatus('working', { note: null });
got = hookStatus('idle', { note: '2000-01-01T00:00:00.000Z' });
check('idle with a note OLDER than the turn start is promoted to needs-input', got === 'needs-input', got);

// A working turn starts, then a note is written (timestamp >= turn start,
// since it's set after), then Stop asks for idle — the fix working as
// instructed: the turn spoke for itself, so idle is trusted.
resetTurnState();
hookStatus('working', { note: null });
const freshNote = new Date().toISOString().replace(/\.\d+Z$/, '.999Z');
got = hookStatus('idle', { note: freshNote });
check('idle with a note covering this turn is left alone', got === 'idle', got);

// Repeated PreToolUse calls within one turn (working -> working -> ... )
// must not keep sliding the turn-start mark forward — a note written just
// after turn start would otherwise still get judged "too old" against a
// mark that crept up to just before Stop.
resetTurnState();
hookStatus('working', { note: null });
const earlyNote = new Date().toISOString();
hookStatus('working', { note: null });
hookStatus('working', { note: null });
got = hookStatus('idle', { note: earlyNote });
check('repeated working calls do not slide the turn-start mark forward', got === 'idle', got);

// Bridge unreachable (curl fails) — must degrade to silence, never assert
// a promotion it can't back, matching the hook-output degrade-to-silence rule.
resetTurnState();
hookStatus('working', { note: null });
got = hookStatus('idle', { curlFails: true });
check('an unreachable bridge fails open — idle is left alone, never blocked', got === 'idle', got);

// The disambiguation from #51 (idle-nudge vs real prompt) and this guard
// must compose: a needs-input that gets downgraded to idle by the #51 fix
// is still subject to the note check.
resetTurnState();
hookStatus('working', { note: null });
const r = spawnSync('bash', ['-c',
  `source ${JSON.stringify(SH)}
   bridge_status() { echo "STATE:$2"; }
   curl() { echo '{"ok":true,"name":"testtab","note":null,"noteUpdatedAt":null}'; }
   bridge_hook_status needs-input --name=testtab`,
], { encoding: 'utf8', input: '{"message":"Claude is waiting for your input"}' });
got = (r.stdout.match(/STATE:(\S+)/) || [])[1];
check('the #51 idle-nudge downgrade still goes through the note guard', got === 'needs-input', got);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
