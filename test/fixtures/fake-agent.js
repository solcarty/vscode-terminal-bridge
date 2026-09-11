#!/usr/bin/env node
// Test double for `claude -p --input-format stream-json --output-format
// stream-json`, speaking the event shapes recorded in the #59 gate spike
// (Claude Code 2.1.268): `user` messages in on stdin; `system`/`assistant`/
// `user`/`result` events out on stdout; permission prompts as
// control_request/can_use_tool, answered by a control_response on stdin.
//
// Messages are processed one turn at a time, so a message sent mid-turn waits
// for the current one — the "queued while busy" case.
//
//   EXIT <code>                   exit immediately with <code>
//   PERMISSION <Tool> <subject>   ask permission for <Tool> before "running"
//   anything else                 one Bash tool call, then echo the text
//
// FAKE_AGENT_TURN_MS  how long each turn's tool "runs" (default 300)
// FAKE_AGENT_ARGV_FILE  if set, argv and the worker env marker are written here
const fs = require('fs');
const readline = require('readline');

const argv = process.argv.slice(2);
const TURN_MS = Number(process.env.FAKE_AGENT_TURN_MS || 300);
if (process.env.FAKE_AGENT_ARGV_FILE) {
  fs.writeFileSync(process.env.FAKE_AGENT_ARGV_FILE, JSON.stringify({
    argv, env: { VSCODE_BRIDGE_WORKER: process.env.VSCODE_BRIDGE_WORKER ?? null },
  }));
}

const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const flagValue = flag => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const sessionId = flagValue('--session-id') || flagValue('--resume');

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake' });

const answers = new Map();
let queue = Promise.resolve();
let n = 0;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response') {
    const resolve = answers.get(msg.response.request_id);
    if (resolve) { answers.delete(msg.response.request_id); resolve(msg.response.response); }
    return;
  }
  if (msg.type === 'user') {
    const text = msg.message.content;
    queue = queue.then(() => turn(text));
  }
});
rl.on('close', () => queue.then(() => process.exit(0)));

async function turn(text) {
  const exit = text.match(/^EXIT (\d+)/);
  if (exit) process.exit(Number(exit[1]));

  const id = `toolu_${++n}`;
  const perm = text.match(/^PERMISSION (\S+) ([\s\S]*)$/);
  const tool = perm ? perm[1] : 'Bash';
  const input = !perm ? { command: 'sleep 0' }
    : tool === 'Bash' ? { command: perm[2] }
    : { file_path: perm[2], content: 'x' };

  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });

  let verdict = 'ran';
  if (perm) {
    const requestId = `req-${n}`;
    const answer = await new Promise(resolve => {
      answers.set(requestId, resolve);
      out({ type: 'control_request', request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: id } });
    });
    verdict = answer.behavior === 'allow' ? 'allowed' : `denied: ${answer.message}`;
  }

  await sleep(TURN_MS);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: verdict }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `echo: ${text}` }] } });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    result: `echo: ${text} [${verdict}]`, session_id: sessionId });
}
