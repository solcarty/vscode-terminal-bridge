// #59 — permission prompts over `--permission-prompt-tool stdio`. The policy
// auto-answers what it matches; anything else sets status=permission and waits
// for an answer through the bridge. While one is outstanding, /send-text
// refuses (409) — the one refusal a headless worker keeps. Also: the policy
// matcher's rules, and the agent's own hooks standing down under the wrapper.
const h = require('./harness');
const w = require('./worker-helpers');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { evaluatePolicy, loadPolicy } = require('../bin/bridge-worker.js');

const cwd = w.mkCwd();
const policyFile = path.join(w.mkCwd(), 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({ allow: ['Write(*/allowed/*)'], deny: ['Bash(rm:*)'] }));

h.state.set(w.KEY, { pm: { cwd, status: 'idle' }, plain: { cwd: path.join(cwd, 'x'), status: 'idle' } });
h.addTerminal(h.makeTerminal('pm'));
h.addTerminal(h.makeTerminal('plain'));
h.ext.activate(h.context);

(async () => {
  const port = await w.bridgePort(h);
  const { check, done } = w.checker();
  const status = async () => (await w.row(port, 'pm')).status;
  const outputHas = text => w.waitFor(async () => (await w.outputs(port, 'pm')).includes(text));

  const proc = w.startWorker({ cwd, name: 'pm', port, args: [`--permission-policy=${policyFile}`],
    env: { FAKE_AGENT_TURN_MS: '50' } });
  await w.waitFor(async () => (await w.row(port, 'pm')).mode === 'headless');

  // 1. policy allow / deny, no human involved
  await w.send(port, 'pm', 'PERMISSION Write /repo/allowed/f.txt');
  check('a policy allow answers the prompt and the tool proceeds',
    !!(await outputHas('echo: PERMISSION Write /repo/allowed/f.txt [allowed]')), { outputs: await w.outputs(port, 'pm'), log: proc.log });
  await w.send(port, 'pm', 'PERMISSION Bash rm -rf /tmp/x');
  check('a policy deny refuses the tool, naming the rule',
    !!(await outputHas('echo: PERMISSION Bash rm -rf /tmp/x [denied: Denied by permission policy rule Bash(rm:*).]')), await w.outputs(port, 'pm'));

  // 2. unmatched → escalated
  await w.send(port, 'pm', 'PERMISSION Bash git push');
  check('an unmatched prompt sets status=permission', !!(await w.waitFor(async () => (await status()) === 'permission')), await status());
  let r = await w.send(port, 'pm', 'more work');
  check('send refuses (409) while a permission request is outstanding', r.code === 409 && r.json.error === 'permission-pending', r.json);
  check('…and says what is pending', r.json.pending?.[0]?.tool_name === 'Bash', r.json);
  r = await w.get(port, '/worker-permission?name=pm');
  check('/worker-permission lists the pending request', r.code === 200 && r.json.pending.length === 1 && r.json.pending[0].input.command === 'git push', r.json);

  // 3. answered through the CLI
  const cli = await w.bridgectl(port, ['worker', 'answer', 'pm', 'deny', '--message=not now']);
  check('`bridgectl worker answer <name> deny` succeeds', cli.code === 0 && /"ok":true/.test(cli.out), cli);
  check('the agent sees the denial and its message', !!(await outputHas('echo: PERMISSION Bash git push [denied: not now]')), await w.outputs(port, 'pm'));
  check('status returns to idle after the turn', !!(await w.waitFor(async () => (await status()) === 'idle')), await status());
  r = await w.get(port, '/worker-permission?name=pm&behavior=allow');
  check('answering with nothing pending → 404', r.code === 404 && r.json.reason === 'no-pending-permission', r.json);

  // 4. answered over HTTP, allow
  await w.send(port, 'pm', 'PERMISSION Bash git fetch');
  await w.waitFor(async () => (await status()) === 'permission');
  r = await w.get(port, '/worker-permission?name=pm&behavior=allow');
  check('/worker-permission behavior=allow answers it', r.code === 200 && r.json.behavior === 'allow', r.json);
  check('the tool proceeds after an allow', !!(await outputHas('echo: PERMISSION Bash git fetch [allowed]')), await w.outputs(port, 'pm'));
  r = await w.get(port, '/worker-permission?name=plain');
  check('/worker-permission on a non-worker terminal → 409', r.code === 409, r.json);

  proc.kill('SIGTERM');
  await proc.exited;

  // 5. an invalid policy is refused at startup, not discovered mid-run
  const badPolicy = path.join(path.dirname(policyFile), 'bad.json');
  fs.writeFileSync(badPolicy, JSON.stringify({ allow: 'Read' }));
  const bad = w.startWorker({ cwd, name: 'pm', port, args: [`--permission-policy=${badPolicy}`] });
  const badExit = await bad.exited;
  check('an invalid policy file exits 2 before spawning anything', badExit.code === 2 && /invalid --permission-policy/.test(bad.log), { badExit, log: bad.log });

  // 6. the matcher
  const p = (allow, deny = []) => ({ allow, deny });
  const decide = (policy, tool, input) => evaluatePolicy(policy, tool, input).decision;
  const gitStatus = p(['Bash(git status:*)']);
  check('Bash(git status:*) allows `git status`', decide(gitStatus, 'Bash', { command: 'git status' }) === 'allow');
  check('…and `git status -s`', decide(gitStatus, 'Bash', { command: 'git status -s' }) === 'allow');
  check('…but not `git statusx`', decide(gitStatus, 'Bash', { command: 'git statusx' }) === null);
  check('…and never a compound command riding on it', decide(gitStatus, 'Bash', { command: 'git status; rm -rf ~' }) === null);
  check('…nor a substitution', decide(gitStatus, 'Bash', { command: 'git status $(curl x)' }) === null);
  check('a bare Bash rule allows anything, because it says so', decide(p(['Bash']), 'Bash', { command: 'a; b' }) === 'allow');
  check('deny wins over allow, on any segment of a compound command',
    decide(p(['Bash'], ['Bash(rm:*)']), 'Bash', { command: 'ls && rm -rf x' }) === 'deny');
  check('a tool-name glob matches its family', decide(p(['mcp__github__*']), 'mcp__github__create_pr', {}) === 'allow');
  check('…and nothing else', decide(p(['mcp__github__*']), 'mcp__gitlab__x', {}) === null);
  check('a bare tool rule is an exact name', decide(p(['Read']), 'ReadX', {}) === null && decide(p(['Read']), 'Read', {}) === 'allow');
  let threw = false;
  try { loadPolicy(badPolicy); } catch { threw = true; }
  check('loadPolicy rejects a non-array rule list', threw);

  // 7. the agent's own status hooks stand down under the wrapper
  const SH = path.join(__dirname, '..', 'bin', 'vscode-bridge.sh');
  const hook = env => spawnSync('bash', ['-c',
    `source ${JSON.stringify(SH)}; bridge_status() { echo "STATE:$2"; }; bridge_hook_status working --name=pm`],
    { encoding: 'utf8', input: '', env: { ...process.env, ...env } }).stdout;
  check('hook-status writes nothing when VSCODE_BRIDGE_WORKER is set', !/STATE:/.test(hook({ VSCODE_BRIDGE_WORKER: '1' })));
  check('…and still writes without it', /STATE:working/.test(hook({})));

  done();
})();
