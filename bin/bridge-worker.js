#!/usr/bin/env node
// bridgectl worker — a headless stream-json agent wrapper (#59).
//
// A tracked terminal normally runs an interactive agent TUI, and an
// orchestrator talks to it by typing into it. Most of the bridge's
// reliability machinery exists to compensate for that: pastes stranded in the
// input box (#48), 409s at prompts because injected text answers the menu, no
// read side, liveness triangulated from a shell that outlives the agent.
//
// When nothing but an orchestrator needs to talk to the agent, none of that is
// necessary. This wrapper runs INSIDE a tracked terminal (so the tab, its icon
// and its /list row all stay) and drives the agent over its structured
// stream-json channel instead:
//
//   - spawns the agent with piped stdin/stdout and persists its session id to
//     <cwd>/.bridge-worker/session
//   - owns an inbox, <cwd>/.bridge-worker/inbox.sock: each message received
//     there is framed as a stream-json `user` message on the agent's stdin.
//     The wrapper is the ONLY writer to that stdin — a second writer on the
//     same session (e.g. `claude -p --resume <id>` alongside) interrupts the
//     live worker's in-flight tool call
//   - renders the event stream readably in the tab, read-only
//   - reports to the bridge from real events, not agent self-report
//   - answers permission prompts from a pluggable policy, escalating anything
//     unmatched to whoever answers the inbox
//   - refuses to start a second worker in the same cwd (lockfile)
//
// Deliberately free of any consumer's vocabulary: the bridge ships the
// mechanism; what to allow, and who answers escalations, is the caller's.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const WORKER_DIR = '.bridge-worker';
const HEARTBEAT_MIN_INTERVAL_MS = 1000;
const STOP_TERM_AFTER_MS = 2000;
const STOP_KILL_AFTER_MS = 10000;
// sun_path is 104 bytes on macOS, 108 on Linux; the smaller one, less the NUL.
const MAX_SOCKET_PATH = 103;

// Exit codes the wrapper itself chooses. Anything else is the agent's own.
const EXIT_USAGE = 2;
const EXIT_LOCKED = 3;
const EXIT_SPAWN_FAILED = 127;

// ---------------------------------------------------------------------------
// Backends — how to spawn an agent that speaks stream-json. Pluggable the same
// way `scaffold --backend` is; `--agent-cmd` swaps only the executable (a
// wrapper script, a pinned binary, a test double) and keeps the backend's args.
// ---------------------------------------------------------------------------
const BACKENDS = {
  claude: {
    command: 'claude',
    args: (opts, session) => [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      ...(session.resume ? ['--resume', session.id] : ['--session-id', session.id]),
      ...(opts.permissionMode ? ['--permission-mode', opts.permissionMode] : []),
      // Prompts the agent's own settings don't already decide arrive on stdout
      // as control_request/can_use_tool and are answered on stdin — see
      // handlePermissionRequest(). Without this, -p denies them outright.
      '--permission-prompt-tool', 'stdio',
      ...(opts.model ? ['--model', opts.model] : []),
    ],
  },
};

const USAGE = `usage: bridgectl.sh worker [--prompt=<text>|--prompt-file=<path>] [--name=<tab>] [--cwd=<dir>]
         [--permission-mode=<mode>] [--permission-policy=<path>] [--model=<model>]
         [--backend=claude] [--agent-cmd=<executable>] [--resume] [-- <extra agent args>]
       bridgectl.sh worker answer <name> allow|deny [--message=<text>] [--request-id=<id>]
       bridgectl.sh worker pending <name>`;

function parseArgs(argv) {
  const opts = { backend: 'claude', extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { opts.extra = argv.slice(i + 1); break; }
    const m = arg.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    if (!m) throw new UsageError(`unexpected argument: ${arg}`);
    const [, key, value] = m;
    const needValue = () => {
      if (value === undefined || value === '') throw new UsageError(`--${key} needs a value (--${key}=...)`);
      return value;
    };
    switch (key) {
      case 'prompt':            opts.prompt = needValue(); break;
      case 'prompt-file':       opts.promptFile = needValue(); break;
      case 'name':              opts.name = needValue(); break;
      case 'cwd':               opts.cwd = needValue(); break;
      case 'model':             opts.model = needValue(); break;
      case 'permission-mode':   opts.permissionMode = needValue(); break;
      case 'permission-policy': opts.permissionPolicy = needValue(); break;
      case 'backend':           opts.backend = needValue(); break;
      case 'agent-cmd':         opts.agentCmd = needValue(); break;
      case 'resume':            opts.resume = true; break;
      case 'help':              throw new UsageError(null);
      default: throw new UsageError(`unknown option: --${key}`);
    }
  }
  if (!BACKENDS[opts.backend]) {
    throw new UsageError(`unknown backend "${opts.backend}" (known: ${Object.keys(BACKENDS).join(', ')})`);
  }
  if (opts.prompt && opts.promptFile) throw new UsageError('pass --prompt or --prompt-file, not both');
  return opts;
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Permission policy
//
// File format (JSON):
//   { "allow": ["Read", "Grep", "Bash(git status:*)", "Edit(/repo/src/*)", "mcp__github__*"],
//     "deny":  ["Bash(rm:*)"] }
//
// A rule is `Tool` or `Tool(spec)`. `Tool` may use `*` as a wildcard. `spec`
// is matched against the tool's subject — the first of command, file_path,
// notebook_path, path, url, pattern found in its input — with `*` matching
// anything; a trailing `:*` means "this command, optionally followed by
// arguments". deny is checked before allow. Anything neither allows nor denies
// escalates.
//
// Bash is the one tool where a string match is not a safety property:
// `Bash(git status:*)` would otherwise match `git status; rm -rf ~`. So an
// allow rule WITH a spec never matches a command containing shell operators
// (; & | ` $ ( ) < > or a newline) — those escalate. A bare `Bash` rule still
// allows everything, because that's what it says. Deny rules go the other way
// and match if ANY segment of a compound command matches.
// ---------------------------------------------------------------------------
const SUBJECT_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern'];
const SHELL_OPERATORS = /[;&|`$()<>\n]/;

function loadPolicy(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy must be a JSON object');
  const policy = {};
  for (const list of ['allow', 'deny']) {
    const rules = raw[list] ?? [];
    if (!Array.isArray(rules) || rules.some(r => typeof r !== 'string' || !parseRule(r))) {
      throw new Error(`policy "${list}" must be an array of rule strings like "Read" or "Bash(git status:*)"`);
    }
    policy[list] = rules;
  }
  return policy;
}

function parseRule(rule) {
  const m = rule.match(/^([^()\s]+)(?:\(([\s\S]*)\))?$/);
  return m ? { tool: m[1], spec: m[2] } : null;
}

function globToRegExp(glob) {
  let prefixOnly = false;
  if (glob.endsWith(':*')) { prefixOnly = true; glob = glob.slice(0, -2); }
  const body = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*');
  return new RegExp(prefixOnly ? `^${body}(\\s[\\s\\S]*)?$` : `^${body}$`);
}

function subjectOf(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of SUBJECT_KEYS) if (typeof input[key] === 'string') return input[key];
  return null;
}

function ruleMatches(rule, toolName, input, { isDeny }) {
  const { tool, spec } = parseRule(rule);
  if (!globToRegExp(tool).test(toolName)) return false;
  if (spec === undefined) return true;
  const subject = subjectOf(input);
  if (subject === null) return false;
  const re = globToRegExp(spec);
  if (toolName === 'Bash') {
    if (isDeny) return subject.split(/&&|\|\||[;|\n]/).some(seg => re.test(seg.trim()));
    if (SHELL_OPERATORS.test(subject)) return false;
  }
  return re.test(subject);
}

// → { decision: 'allow'|'deny'|null, rule }
function evaluatePolicy(policy, toolName, input) {
  for (const rule of policy.deny) {
    if (ruleMatches(rule, toolName, input, { isDeny: true })) return { decision: 'deny', rule };
  }
  for (const rule of policy.allow) {
    if (ruleMatches(rule, toolName, input, { isDeny: false })) return { decision: 'allow', rule };
  }
  return { decision: null, rule: null };
}

// ---------------------------------------------------------------------------
// Single-worker lock. Written with O_EXCL, so two wrappers racing for the same
// cwd cannot both win; a lock whose pid is gone is stale and taken over.
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function acquireLock(lockPath, info) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(info), { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* torn or empty — stale */ }
      if (held && pidAlive(held.pid)) return { ok: false, held };
      fs.rmSync(lockPath, { force: true });
    }
  }
  return { ok: false, held: null };
}

// ---------------------------------------------------------------------------
// Bridge reporting. Best-effort by construction: the agent keeps working
// whether or not VS Code is there to watch it. Calls are serialized so status
// transitions land in the order they happened.
// ---------------------------------------------------------------------------
function resolvePort(cwd) {
  if (process.env.VSCODE_BRIDGE_PORT) return process.env.VSCODE_BRIDGE_PORT;
  let dir = cwd;
  while (dir && dir !== path.dirname(dir)) {
    try { return fs.readFileSync(path.join(dir, '.vscode-bridge-port'), 'utf8').trim(); } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  try { return fs.readFileSync(path.join(os.homedir(), '.vscode-terminal-bridge', 'port'), 'utf8').trim(); } catch { /* none */ }
  return '31415';
}

function makeReporter(name, port) {
  let chain = Promise.resolve();
  let lastStatus = null;
  let lastBeat = 0;

  const call = (pathname, params) => {
    if (!name) return chain;
    const qs = new URLSearchParams({ name, ...params }).toString();
    chain = chain.then(() => new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: `${pathname}?${qs}`, timeout: 2000 }, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', resolve);
    }));
    return chain;
  };

  return {
    status(s) {
      if (s === lastStatus) return chain;
      lastStatus = s;
      lastBeat = Date.now(); // /rename-terminal stamps the heartbeat itself
      return call('/rename-terminal', { status: s });
    },
    heartbeat() {
      const now = Date.now();
      if (now - lastBeat < HEARTBEAT_MIN_INTERVAL_MS) return chain;
      lastBeat = now;
      return call('/heartbeat', {});
    },
    output(file) { return call('/set-output', { textFile: file }); },
    note(file) { return call('/set-note', { textFile: file }); },
    drain() { return chain; },
  };
}

// ---------------------------------------------------------------------------
// Rendering — a read-only view for a human watching the tab.
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const dim = s => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const bold = s => (tty ? `\x1b[1m${s}\x1b[22m` : s);
const oneLine = (s, max = 160) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const say = line => process.stdout.write(`${line}\n`);

function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const subject = subjectOf(input) ?? input.description ?? input.prompt;
  return oneLine(subject ?? JSON.stringify(input), 120);
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------
async function main(argv, onStop = () => {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (err.message) process.stderr.write(`bridgectl worker: ${err.message}\n`);
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }

  const cwd = path.resolve(opts.cwd || process.cwd());
  const name = opts.name || process.env.CLAUDE_TAB_NAME || null;
  const dir = path.join(cwd, WORKER_DIR);
  const lockPath = path.join(dir, 'lock');
  const sessionPath = path.join(dir, 'session');
  // Unix socket paths are capped near 104 bytes, and a deep cwd blows through
  // that. The bridge finds the socket through the lock, not by convention, so
  // a too-long cwd gets one in the temp dir, keyed by the cwd, instead.
  let socketPath = path.join(dir, 'inbox.sock');
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    const key = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
    socketPath = path.join(os.tmpdir(), `bridge-worker-${key}.sock`);
  }

  let prompt = opts.prompt ?? null;
  if (opts.promptFile) {
    try { prompt = fs.readFileSync(opts.promptFile, 'utf8'); } catch (err) {
      process.stderr.write(`bridgectl worker: cannot read --prompt-file: ${err.message}\n`);
      return EXIT_USAGE;
    }
  }
  let policy = null;
  if (opts.permissionPolicy) {
    try { policy = loadPolicy(opts.permissionPolicy); } catch (err) {
      process.stderr.write(`bridgectl worker: invalid --permission-policy ${opts.permissionPolicy}: ${err.message}\n`);
      return EXIT_USAGE;
    }
  }
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    process.stderr.write(`bridgectl worker: inbox socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH}-byte unix socket limit: ${socketPath}\n`);
    return EXIT_USAGE;
  }

  fs.mkdirSync(dir, { recursive: true });
  // Runtime state, never source. Self-ignoring so no consumer has to know.
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }); } catch { /* exists */ }

  // Lock BEFORE touching the session file: a refused second worker must not
  // overwrite the running one's session id.
  const lockInfo = { pid: process.pid, agentPid: null, socket: socketPath, sessionId: null, name, startedAt: new Date().toISOString() };
  const lock = acquireLock(lockPath, lockInfo);
  if (!lock.ok) {
    const who = lock.held ? `pid ${lock.held.pid}${lock.held.name ? `, tab ${lock.held.name}` : ''}` : 'another process';
    process.stderr.write(`bridgectl worker: a worker is already running in ${cwd} (${who}). One worker per cwd — send to it instead, or stop it first.\n`);
    return EXIT_LOCKED;
  }

  const session = { id: null, resume: false };
  if (opts.resume) {
    try { session.id = fs.readFileSync(sessionPath, 'utf8').trim(); } catch { /* handled below */ }
    if (!session.id) {
      fs.rmSync(lockPath, { force: true });
      process.stderr.write(`bridgectl worker: --resume given but ${sessionPath} has no session id\n`);
      return EXIT_USAGE;
    }
    session.resume = true;
  } else {
    session.id = crypto.randomUUID();
    fs.writeFileSync(sessionPath, `${session.id}\n`);
  }
  lockInfo.sessionId = session.id;

  const report = makeReporter(name, resolvePort(cwd));
  if (!name) say(dim('bridge-worker: no --name and no CLAUDE_TAB_NAME — running without bridge reporting'));

  const backend = BACKENDS[opts.backend];
  const command = opts.agentCmd || backend.command;
  const args = [...backend.args(opts, session), ...opts.extra];

  // ── state ────────────────────────────────────────────────────────────────
  const pending = new Map(); // request_id → can_use_tool request awaiting an answer
  let busy = false;
  let stopping = false;
  let finished = false;
  let agent;

  const writeFileFor = (file, text) => { fs.writeFileSync(path.join(dir, file), text); return path.join(dir, file); };
  const pendingSummary = () => [...pending.entries()].map(([requestId, r]) => ({
    requestId, tool_name: r.tool_name, input: r.input, tool_use_id: r.tool_use_id ?? null,
  }));
  const toAgent = obj => {
    if (!agent || agent.exitCode !== null || agent.stdin.destroyed) return false;
    agent.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  };

  function sendUser(text, source) {
    const queued = busy;
    if (!toAgent({ type: 'user', message: { role: 'user', content: text } })) return null;
    busy = true;
    say(bold(`← ${source}${queued ? ' (queued)' : ''}: `) + oneLine(text));
    report.status('working');
    return { queued };
  }

  function answerPermission(requestId, behavior, message) {
    const req = pending.get(requestId);
    if (!req) return false;
    pending.delete(requestId);
    const response = behavior === 'allow'
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: message || 'Denied.' };
    toAgent({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    if (pending.size === 0) report.status('working');
    return true;
  }

  function handlePermissionRequest(ev) {
    const req = ev.request;
    pending.set(ev.request_id, req);
    let verdict = { decision: null, rule: null };
    if (policy) {
      // Re-read so edits apply to a running worker. A policy that no longer
      // parses fails CLOSED — to a human, never to an automatic allow.
      try { verdict = evaluatePolicy(loadPolicy(opts.permissionPolicy), req.tool_name, req.input); }
      catch (err) { say(dim(`bridge-worker: policy unreadable (${err.message}) — escalating`)); }
    }
    if (verdict.decision === 'allow') {
      say(dim(`  ✓ policy allowed ${req.tool_name} (${verdict.rule})`));
      answerPermission(ev.request_id, 'allow');
    } else if (verdict.decision === 'deny') {
      say(dim(`  ✗ policy denied ${req.tool_name} (${verdict.rule})`));
      answerPermission(ev.request_id, 'deny', `Denied by permission policy rule ${verdict.rule}.`);
    } else {
      say(bold(`? permission needed: ${req.tool_name} ${toolSummary(req.input)}`));
      say(dim(`  answer with: bridgectl.sh worker answer ${name ?? '<name>'} allow|deny [--message=...]`));
      report.status('permission');
    }
  }

  function onEvent(ev) {
    report.heartbeat();
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') say(dim(`session ${ev.session_id ?? session.id}${ev.model ? ` · ${ev.model}` : ''}`));
        break;
      case 'assistant':
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text) say(block.text);
          if (block.type === 'tool_use') {
            say(dim(`→ ${block.name} ${toolSummary(block.input)}`));
            report.status(pending.size ? 'permission' : 'working');
          }
        }
        break;
      case 'user':
        for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          if (block.type === 'tool_result' && block.is_error) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            say(dim(`  ↳ error: ${oneLine(text, 120)}`));
          }
        }
        break;
      case 'result': {
        busy = false;
        const text = typeof ev.result === 'string' ? ev.result : `(${ev.subtype ?? 'result'} with no text)`;
        say(dim(`✓ turn done${ev.num_turns ? ` · ${ev.num_turns} turns` : ''}${ev.is_error ? ' · error' : ''}`));
        report.output(writeFileFor('output.txt', text));
        report.status(pending.size ? 'permission' : 'idle');
        break;
      }
      case 'control_request':
        if (ev.request?.subtype === 'can_use_tool') handlePermissionRequest(ev);
        else toAgent({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `bridge-worker does not handle ${ev.request?.subtype}` } });
        break;
      case 'control_cancel_request':
        if (pending.delete(ev.request_id) && pending.size === 0) report.status(busy ? 'working' : 'idle');
        break;
      default:
        break;
    }
  }

  // ── inbox ────────────────────────────────────────────────────────────────
  // One newline-terminated JSON request per connection, one JSON reply.
  function handleInbox(req) {
    switch (req && req.op) {
      case 'send': {
        if (typeof req.text !== 'string' || req.text === '') return { ok: false, code: 400, reason: 'no-text' };
        if (pending.size && !req.force) {
          return { ok: false, code: 409, reason: 'permission-pending', pending: pendingSummary() };
        }
        const sent = sendUser(req.text, req.source || 'inbox');
        if (!sent) return { ok: false, code: 503, reason: 'agent-not-running' };
        return { ok: true, delivery: 'inbox', queued: sent.queued };
      }
      case 'permission': {
        if (!['allow', 'deny'].includes(req.behavior)) return { ok: false, code: 400, reason: 'behavior must be allow or deny' };
        let id = req.requestId;
        if (!id) {
          if (pending.size === 0) return { ok: false, code: 404, reason: 'no-pending-permission' };
          if (pending.size > 1) return { ok: false, code: 409, reason: 'several-pending: pass requestId', pending: pendingSummary() };
          id = pending.keys().next().value;
        }
        const tool = pending.get(id)?.tool_name;
        if (!answerPermission(id, req.behavior, req.message)) return { ok: false, code: 404, reason: 'no-such-request', pending: pendingSummary() };
        say(bold(`← permission ${req.behavior}: ${tool}`));
        return { ok: true, requestId: id, behavior: req.behavior };
      }
      case 'status':
        return { ok: true, pid: process.pid, agentPid: agent?.pid ?? null, sessionId: session.id, busy, pending: pendingSummary() };
      case 'stop':
        stop();
        return { ok: true, stopping: true };
      default:
        return { ok: false, code: 400, reason: 'unknown op' };
    }
  }

  // We hold the lock, so any socket file here is a previous worker's leftover.
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let reply;
      try { reply = handleInbox(JSON.parse(buf.slice(0, nl))); } catch { reply = { ok: false, code: 400, reason: 'malformed request' }; }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);

  // ── agent ────────────────────────────────────────────────────────────────
  // Own process group, so a Ctrl-C in the tab reaches the wrapper alone and
  // the agent is stopped by stop()'s ordered sequence instead of mid-write.
  agent = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, VSCODE_BRIDGE_WORKER: '1', VSCODE_BRIDGE_WORKER_DIR: dir },
  });
  agent.stdin.on('error', () => {}); // EPIPE after the agent exits is not ours to report
  onStop(stop);

  // The lock is also what the bridge reads to call this terminal headless, so
  // it carries what a caller needs: the session to take over, the agent's pid.
  fs.writeFileSync(lockPath, JSON.stringify({ ...lockInfo, agentPid: agent.pid ?? null }));

  if (prompt) sendUser(prompt, 'prompt');
  else report.status('idle');

  let outBuf = '';
  agent.stdout.setEncoding('utf8');
  agent.stdout.on('data', chunk => {
    outBuf += chunk;
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { say(line); report.heartbeat(); continue; }
      onEvent(ev);
    }
  });
  agent.stderr.setEncoding('utf8');
  agent.stderr.on('data', chunk => process.stdout.write(dim(chunk)));

  const exitCode = await new Promise(resolve => {
    const finish = (code, why, spawnError) => {
      if (finished) return;
      finished = true;
      const resumeHint = `Session ${session.id}. Take over with: claude --resume ${session.id}`;
      if (spawnError) {
        report.note(writeFileFor('note.txt', `bridge-worker: failed to start agent "${command}": ${spawnError.message}`));
        report.status('error');
      } else if (stopping) {
        report.note(writeFileFor('note.txt', `bridge-worker: stopped on request (${why}). ${resumeHint}`));
        report.status('idle');
      } else {
        report.note(writeFileFor('note.txt', `bridge-worker: agent exited with ${why}. ${resumeHint}`));
        report.status('error');
      }
      say(bold(`bridge-worker: agent ${spawnError ? `failed to start: ${spawnError.message}` : `exited with ${why}`}`));
      server.close();
      fs.rmSync(socketPath, { force: true });
      fs.rmSync(lockPath, { force: true });
      report.drain().then(() => resolve(code));
    };
    agent.on('error', err => finish(EXIT_SPAWN_FAILED, null, err));
    agent.on('exit', (code, signal) => finish(code ?? 1, signal ? `signal ${signal}` : `code ${code}`));
  });
  return exitCode;

  // Graceful first: closing stdin lets the agent end on its own terms; the
  // signals are for an agent that won't.
  function stop() {
    if (stopping || finished) return;
    stopping = true;
    try { agent.stdin.end(); } catch { /* already closed */ }
    const signalGroup = sig => { try { process.kill(-agent.pid, sig); } catch { /* gone */ } };
    setTimeout(() => { if (!finished) signalGroup('SIGTERM'); }, STOP_TERM_AFTER_MS).unref();
    setTimeout(() => { if (!finished) signalGroup('SIGKILL'); }, STOP_KILL_AFTER_MS).unref();
  }
}

// A signal to the wrapper (Ctrl-C in the tab, a kill from a manager) is a
// requested stop: the agent is wound down in order and the exit reported as
// such, not as a crash. Before the agent exists there is nothing to wind down.
function run() {
  let stopHook = null;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { if (stopHook) stopHook(); else process.exit(130); });
  }
  main(process.argv.slice(2), h => { stopHook = h; }).then(
    code => { process.exitCode = code; },
    err => { process.stderr.write(`bridgectl worker: ${err.stack || err.message}\n`); process.exitCode = 1; },
  );
}

if (require.main === module) run();

module.exports = { parseArgs, loadPolicy, evaluatePolicy, acquireLock, BACKENDS };
