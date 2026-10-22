// what a stage does to a panel row: icon, colour, description, hover.
const { buildRows } = require('../panel');

const STATUS_MAP = {
  'working':     { codicon: 'loading~spin', color: 'terminal.ansiCyan' },
  'needs-input': { codicon: 'bell-dot',     color: 'terminal.ansiYellow' },
  'idle':        { codicon: 'debug-pause',  color: 'terminal.ansiGreen' },
  'permission':  { codicon: 'shield',       color: 'terminal.ansiBlue' },
  'error':       { codicon: 'error',        color: 'terminal.ansiRed' },
};
const displayStatusKey = m =>
  ['needs-input', 'permission', 'error'].includes(m.status) ? m.status : (m.status ?? null);
const STAGES = [
  { key: 'build',  label: 'Build',  codicon: 'tools' },
  { key: 'review', label: 'Review', codicon: 'eye' },
  { key: 'merged', label: 'Merged', codicon: 'git-merge', terminal: true },
];

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const at = min => new Date(Date.UTC(2026, 9, 16, 12, min)).toISOString();
const NOW = Date.parse(at(30));
const one = (meta, stages = STAGES) =>
  buildRows({ w: meta }, { statusMap: STATUS_MAP, displayStatusKey, now: NOW, stages })[0];

// icon and colour
{
  const r = one({ status: 'working', stage: 'review', stageChangedAt: at(10) });
  check('the stage codicon replaces the status icon', r.codicon === 'eye', r);
  check('…coloured by the turn status', r.color === 'terminal.ansiCyan', r);
}
for (const status of ['needs-input', 'permission', 'error']) {
  const r = one({ status, stage: 'review', stageChangedAt: at(10) });
  check(`${status} overrides the stage icon and colour`,
    r.codicon === STATUS_MAP[status].codicon && r.color === STATUS_MAP[status].color, r);
  check(`${status}: the stage still shows in the description`, r.description === 'Review', r);
}

// description
check('description is the label alone, no stage position',
  one({ status: 'idle', stage: 'build' }).description === 'Build');
check('description appends the detail',
  one({ status: 'idle', stage: 'review', stageDetail: 'PR 12' }).description === 'Review · PR 12');
check('a stage beats the progress label and the note',
  one({ status: 'idle', baseLabel: 'w step 4', note: 'a note', stage: 'build' }).description === 'Build');

check('a caller count is the only fraction',
  one({ status: 'idle', stage: 'review', stageDetail: '12/39 checks' }).description === 'Review · 12/39 checks');

// unknown key
{
  const r = one({ status: 'idle', stage: 'mystery', stageDetail: 'x', stageChangedAt: at(20) });
  check('an unknown key shows as text, with the detail', r.description === 'mystery · x', r);
  check('…with a neutral icon, status colour kept', r.codicon === 'circle-outline' && r.color === 'terminal.ansiGreen', r);
  check('…and its age in the hover', r.tooltip.startsWith('stage: mystery for 10m'), r.tooltip);
}
{
  const r = one({ status: 'idle', stage: 'build' }, []);
  check('with no stages configured a stage is still text', r.description === 'build' && r.codicon === 'circle-outline', r);
}

// no stage: unchanged
{
  const withNote = one({ status: 'idle', baseLabel: 'w', note: '\nshipped: pr=1\n' });
  check('no stage → first note line as before', withNote.description === 'shipped: pr=1', withNote);
  check('no stage → status icon as before', withNote.codicon === 'debug-pause', withNote);
  check('no stage → tooltip has no step list', !withNote.tooltip.includes('✓') && !withNote.tooltip.includes('○'), withNote.tooltip);
  const a = one({ status: 'working', baseLabel: 'w 3/9', note: 'n' });
  const b = one({ status: 'working', baseLabel: 'w 3/9', note: 'n' }, []);
  check('stages configured but unused → identical row', JSON.stringify(a) === JSON.stringify(b), [a, b]);
}

// hover
{
  const r = one({ status: 'working', stage: 'review', stageChangedAt: at(10), statusChangedAt: at(25), note: 'hi', prUrl: 'u' });
  const lines = r.tooltip.split('\n');
  check('hover lists done, current with age, then the rest',
    lines.slice(0, 3).join('|') === '✓ Build|▸ Review — current for 20m|○ Merged', lines);
  check('…then the existing lines', lines.includes('working for 5m') && lines.includes('hi') && lines.includes('PR: u'), lines);
}
{
  const r = one({ status: 'idle', stage: 'merged', stageChangedAt: at(0) });
  check('a terminal stage shows as done', r.tooltip.split('\n').slice(0, 3).join('|') === '✓ Build|✓ Review|✓ Merged for 30m', r.tooltip);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
