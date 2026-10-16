// #6943 — the side panel's row model, from registry rows alone. Pure: no
// vscode mock, no bridge, so what a row shows and where it sorts is pinned
// independently of how the TreeView renders it.
const { buildRows, progressText } = require('../panel');

const STATUS_MAP = {
  'working':     { codicon: 'loading~spin',   color: 'terminal.ansiCyan' },
  'needs-input': { codicon: 'bell-dot',       color: 'terminal.ansiYellow' },
  'idle':        { codicon: 'debug-pause',    color: 'terminal.ansiGreen' },
  'permission':  { codicon: 'shield',         color: 'terminal.ansiBlue' },
  'error':       { codicon: 'error',          color: 'terminal.ansiRed' },
  'bg-task':     { codicon: 'server-process', color: 'terminal.ansiBlue' },
};
// Same precedence as extension.js's displayStatusKey.
const displayStatusKey = m =>
  ['needs-input', 'permission', 'error'].includes(m.status) ? m.status
    : (Number(m.pendingTasks) || 0) > 0 ? 'bg-task' : (m.status ?? null);

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const at = min => new Date(Date.UTC(2026, 9, 16, 12, min)).toISOString();
const NOW = Date.parse(at(30));
const rows = (meta, opts = {}) => buildRows(meta, { statusMap: STATUS_MAP, displayStatusKey, now: NOW, ...opts });

// ── label, description, icon ────────────────────────────────────────────────
{
  const [r] = rows({ 'feat-1': {
    status: 'working', baseLabel: 'feat-1 8/1/9 next 16:10', label: '$(loading~spin) feat-1 8/1/9 next 16:10',
    note: 'should not show — progress wins', createdAt: at(0),
  } });
  check('label is the name', r.label === 'feat-1', r);
  check('description is the rename label minus the name', r.description === '8/1/9 next 16:10', r);
  check('icon is the status codicon', r.codicon === 'loading~spin', r);
  check('icon color is the status color', r.color === 'terminal.ansiCyan', r);
}
{
  const [r] = rows({ 'w': { status: 'idle', baseLabel: 'w', note: '\n  shipped: pr=12 sha=abc\ntouched: none\n' } });
  check('no progress → first non-empty line of the note', r.description === 'shipped: pr=12 sha=abc', r);
}
{
  const [r] = rows({ 'w': { status: null } });
  check('no progress, no note → empty description', r.description === '', r);
  check('no status → no icon', r.codicon === null && r.color === null, r);
}
check('progress strips codicons and separators', progressText({ label: '$(bell) w · step 3' }, 'w') === 'step 3');
check('a label not mentioning the name is all progress', progressText({ baseLabel: 'Deploying 2/5' }, 'w') === 'Deploying 2/5');
{
  const [r] = rows({ 'w': { status: 'working', pendingTasks: 1 } });
  check('icon follows displayStatus (bg-task outranks working)', r.codicon === 'server-process', r);
  check('…but the row still groups as working', r.group === 1, r);
}

// ── tooltip ─────────────────────────────────────────────────────────────────
{
  const [r] = rows({ 'w': {
    status: 'needs-input', statusChangedAt: at(18), note: 'need a decision on X',
    cmdDelivery: 'timeout', prUrl: 'https://github.com/o/r/pull/9', node: 'm1',
  } });
  for (const part of ['needs-input for 12m', 'need a decision on X', 'cmd: timeout', 'PR: https://github.com/o/r/pull/9', 'node: m1']) {
    check(`tooltip carries "${part}"`, r.tooltip.includes(part), r.tooltip);
  }
}
{
  const [r] = rows({ 'w': { status: 'idle' } });
  check('tooltip omits unset fields', r.tooltip === 'idle', r.tooltip);
}

// ── order ───────────────────────────────────────────────────────────────────
{
  const order = rows({
    'idle-old':    { status: 'idle',        createdAt: at(1) },
    'work-old':    { status: 'working',     createdAt: at(2) },
    'err':         { status: 'error',       createdAt: at(3) },
    'idle-new':    { status: 'idle',        createdAt: at(4) },
    'perm':        { status: 'permission',  createdAt: at(5) },
    'work-new':    { status: 'working',     createdAt: at(6) },
    'ask':         { status: 'needs-input', createdAt: at(7) },
    'legacy':      { status: 'idle' },
    'none':        { createdAt: at(8) },
  }).map(r => r.name);
  const want = ['ask', 'perm', 'err', 'work-new', 'work-old', 'none', 'idle-new', 'idle-old', 'legacy'];
  check('attention first, then working, then the rest; newest first in each', JSON.stringify(order) === JSON.stringify(want), order);
}

// ── liveness ────────────────────────────────────────────────────────────────
{
  const names = rows({ a: { status: 'idle' }, gone: { status: 'working' } }, { isLive: n => n !== 'gone' }).map(r => r.name);
  check('a row whose terminal is gone is dropped', JSON.stringify(names) === '["a"]', names);
}

process.exit(fails ? 1 : 0);
