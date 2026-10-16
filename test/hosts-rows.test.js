// #6946 — the All hosts view's model, from recorded `hostsCommand` JSON alone.
// Pure: no vscode mock, no command run. The fixtures are the contract's shape
// (README, "All hosts view") with made-up hosts.
const fs = require('fs');
const path = require('path');
const { buildRows } = require('../panel');
const { readingLine, parseHostsDoc, recordGood, buildHosts } = require('../hosts');

const STATUS_MAP = {
  'working':     { codicon: 'loading~spin',   color: 'terminal.ansiCyan' },
  'needs-input': { codicon: 'bell-dot',       color: 'terminal.ansiYellow' },
  'idle':        { codicon: 'debug-pause',    color: 'terminal.ansiGreen' },
  'permission':  { codicon: 'shield',         color: 'terminal.ansiBlue' },
  'error':       { codicon: 'error',          color: 'terminal.ansiRed' },
  'bg-task':     { codicon: 'server-process', color: 'terminal.ansiBlue' },
};
const displayStatusKey = m =>
  ['needs-input', 'permission', 'error'].includes(m.status) ? m.status
    : (Number(m.pendingTasks) || 0) > 0 ? 'bg-task' : (m.status ?? null);

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const fixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const opts = extra => ({ statusMap: STATUS_MAP, displayStatusKey, now: NOW, ...extra });

// ── the memory line ─────────────────────────────────────────────────────────
check('full reading', readingLine({ load: 0.47, cpus: 16, memAvailableGb: 23.2, memTotalGb: 31.1, workers: 3, workerCap: 4 })
  === 'load 0.47 / 16 · 23 of 31 GB free · 3 of 4 workers');
check('unknown parts are left out', readingLine({ load: null, cpus: 8, memAvailableGb: null, memTotalGb: 16, workers: 2 })
  === '8 cpus · 2 workers', readingLine({ load: null, cpus: 8, memAvailableGb: null, memTotalGb: 16, workers: 2 }));
check('nothing known → empty', readingLine({}) === '');

// ── parsing: stdout decides, not the exit code ──────────────────────────────
check('a document parses', parseHostsDoc(fixture('hosts-one-down.json')).doc?.hosts.length === 3);
check('non-JSON is an error', /not JSON/.test(parseHostsDoc('ssh: oops').error));
check('JSON without hosts is an error', /no hosts/.test(parseHostsDoc('{"terminals":[]}').error));

// ── all up: one header per host, rows like the Terminals view ──────────────
const up = parseHostsDoc(fixture('hosts-all-up.json')).doc;
{
  const hosts = buildHosts(up, opts());
  check('one header per host, document order', JSON.stringify(hosts.map(h => h.name)) === '["local","host-a","host-b"]', hosts.map(h => h.name));
  const [local, a, b] = hosts;
  check('header reading is the memory line', local.description === '1 needs a person · load 0.47 / 16 · 23 of 31 GB free · 3 of 4 workers', local.description);
  check('self comes from the document', local.self === true && a.self === false, [local.self, a.self]);
  check('a host with no one waiting has no count', b.attention === 0 && b.description === 'load 0.05 / 4 · 7 of 8 GB free · 0 of 1 workers', b.description);
  check('attention counts needs-input, permission and error', a.attention === 2 && a.description.startsWith('2 need a person · '), a.description);
  check('remoteUri is passed through', a.remoteUri === 'vscode-remote://ssh-remote+host-a/home/me/repo' && b.remoteUri === null, [a.remoteUri, b.remoteUri]);

  // Same shape and order as the Terminals view, fed the same rows.
  const meta = Object.fromEntries(up.hosts[0].terminals.filter(t => t.live).map(t => [t.name, t]));
  const expected = buildRows(meta, opts());
  check('host rows are the Terminals view\'s rows', JSON.stringify(local.rows) === JSON.stringify(expected), local.rows);
  check('attention first, then working, then the rest', JSON.stringify(local.rows.map(r => r.name)) === '["w-102","w-101","orch"]', local.rows.map(r => r.name));
  check('a dead terminal is dropped', !local.rows.some(r => r.name === 'gone'));
  check('row description is the progress text', local.rows[1].description === '3/5 tests', local.rows[1]);
  check('row icon is the status codicon, newest first in a group', a.rows[0].name === 'w-202' && a.rows[0].codicon === 'error', a.rows[0]);
}

// ── one host down: its error and last reading's age; the others intact ─────
{
  const lastGood = recordGood({}, up, NOW - 4 * 60 * 1000);
  const down = parseHostsDoc(fixture('hosts-one-down.json')).doc;
  const hosts = buildHosts(down, opts({ lastGood }));
  const [local, a, b] = hosts;
  check('the down host still has a header', b && b.name === 'host-b' && b.ok === false, b);
  check('its header shows the error and the last reading\'s age',
    b.description === 'ssh: connect to host host-b port 22: Operation timed out · last reading 4m ago', b.description);
  check('it keeps the last good reading and terminals', b.reading === 'load 0.05 / 4 · 7 of 8 GB free · 0 of 1 workers'
    && b.rows.map(r => r.name).join() === 'w-301', b);
  check('the others are not blanked', local.ok && a.ok && local.rows.length === 3 && a.rows.length === 3, hosts.map(h => h.rows.length));

  const never = buildHosts(down, opts())[2];
  check('a host never seen up says so', never.description.endsWith('· no reading yet') && never.rows.length === 0, never.description);
  check('recordGood skips the down host', recordGood({}, down, NOW)['host-b'] === undefined);
}

process.exit(fails ? 1 : 0);
