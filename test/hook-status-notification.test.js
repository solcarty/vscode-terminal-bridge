// Claude Code fires `Notification` for two unrelated things: a real
// permission/input request, and the "waiting for your input" nudge that
// arrives after ~60s of quiet. The hook command is a fixed string, so both
// used to land as `needs-input` — the one status asserting a human is
// required, which `send`/`nudge` refuse on. Any agent that finished its turn
// and sat quiet therefore falsely claimed to need a human.
//
// bridge_hook_status now disambiguates on the payload. Fail-safe by
// construction: ONLY the known idle phrasings are downgraded, so an
// unrecognized or absent message still asserts `needs-input` and a real
// permission prompt is never silently demoted. These cases are the contract.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SH = path.join(__dirname, '..', 'bin', 'vscode-bridge.sh');

// Stub bridge_status so we observe the decision without a live bridge.
const decide = (state, payload) => {
  const r = spawnSync('bash', ['-c',
    `source ${JSON.stringify(SH)}
     bridge_status() { echo "STATE:$2"; }
     bridge_hook_status ${state} --name=testtab`,
  ], { input: payload, encoding: 'utf8' });
  const m = (r.stdout || '').match(/STATE:(\S+)/);
  return m ? m[1] : `<no decision: ${r.stderr.trim()}>`;
};

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

let got = decide('needs-input', '{"message":"Claude is waiting for your input","session_id":"x"}');
check('idle nudge is downgraded to idle', got === 'idle', got);

got = decide('needs-input', '{"message":"Claude needs your permission to use Bash","session_id":"x"}');
check('permission request stays needs-input', got === 'needs-input', got);

got = decide('needs-input', '');
check('empty payload stays needs-input', got === 'needs-input', got);

got = decide('needs-input', '{"session_id":"x"}');
check('payload with no message stays needs-input', got === 'needs-input', got);

got = decide('needs-input', '{"message":"Something else entirely"}');
check('unrecognized message stays needs-input', got === 'needs-input', got);

got = decide('working', '{"message":"Claude is waiting for your input"}');
check('non-needs-input states are untouched', got === 'working', got);

// #82 — payloads captured from Claude Code 2.1.302 with a hook that wrote
// stdin to a file. Both carry `notification_type`, which is preferred over
// the message wording; the message match is the fallback when it's absent.
const fixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-hooks', f), 'utf8');

got = decide('needs-input', fixture('notification-idle-prompt.json'));
check('real idle_prompt payload is downgraded to idle', got === 'idle', got);

got = decide('needs-input', fixture('notification-permission-prompt.json'));
check('real permission_prompt payload stays needs-input', got === 'needs-input', got);

got = decide('needs-input', '{"message":"Claude is waiting for your input","notification_type":"permission_prompt"}');
check('notification_type permission_prompt wins over idle wording', got === 'needs-input', got);

got = decide('needs-input', '{"message":"Something new","notification_type":"some_future_type"}');
check('unknown notification_type stays needs-input', got === 'needs-input', got);

got = decide('needs-input', '{"message":"Claude is waiting for your input","notification_type":"some_future_type"}');
check('unknown notification_type is not demoted by idle wording', got === 'needs-input', got);

got = decide('needs-input', '{"message":"Reworded nudge","notification_type":"idle_prompt"}');
check('idle_prompt is downgraded whatever the wording', got === 'idle', got);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
