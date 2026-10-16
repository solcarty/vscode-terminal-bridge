// tmuxRun when tmux exits before reading its stdin (#79): the write fails with
// EPIPE, which must not crash the process — the exit code decides the result.
// Uses a fake tmux, so it needs no real one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-'));
const fake = path.join(dir, 'tmux');
fs.writeFileSync(fake, '#!/bin/sh\ncase "$*" in *ok*) exit 0;; esac\necho "error connecting to /tmp/x" >&2\nexit 1\n', { mode: 0o755 });
process.env.VSCODE_BRIDGE_TMUX = fake;
const { tmuxRun } = require('../headless');

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

const uncaught = [];
process.on('uncaughtException', e => uncaught.push(e));

(async () => {
  const big = 'x'.repeat(1 << 20); // too big for the pipe buffer, so the write outlives the child
  let rejected = 0;
  let resolved = 0;
  for (let i = 0; i < 50; i++) {
    await tmuxRun('s', ['list-sessions'], big).then(() => resolved++, e => { if (/error connecting/.test(e.message)) rejected++; });
    await tmuxRun('s', ['ok'], big).then(() => resolved++, () => {});
  }
  await new Promise(r => setTimeout(r, 100));
  check('no uncaught EPIPE', uncaught.length === 0, uncaught.map(e => e.message));
  check('non-zero exit rejects with stderr', rejected === 50, rejected);
  check('zero exit resolves', resolved === 50, resolved);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
