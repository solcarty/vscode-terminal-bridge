// #6946 — the All hosts view wired into activate(): its command runs only
// while the view is visible, a failed run keeps the last good result marked
// stale, and a click shows, opens or copies depending on where the row lives.
// The command is a real shell command that replays recorded JSON and counts
// its own runs in a file, so "not run while hidden" is observed, not assumed.
process.env.VSCODE_BRIDGE_HOSTS_INTERVAL_MS = '150';
process.env.VSCODE_BRIDGE_HOSTS_TIMEOUT_MS = '400';
const h = require('./harness');
const fs = require('fs');
const path = require('path');
const { VIEW_ID, OPEN_COMMAND } = require('../hosts');
const { SHOW_COMMAND } = require('../panel');

const wait = ms => new Promise(r => setTimeout(r, ms));
const counter = path.join(process.env.HOME, 'hosts-runs');
const runs = () => { try { return fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const fixture = f => path.join(__dirname, 'fixtures', f);
// Exits 2 like a producer reporting a host down — stdout decides, not the code.
const replay = (f, code = 0) => `echo run >> '${counter}'; cat '${fixture(f)}'; exit ${code}`;

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

(async () => {
  // ── empty setting: registered, never runs ────────────────────────────────
  h.ext.activate(h.context);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = (pkg.contributes.views?.terminalBridge ?? []).find(v => v.id === VIEW_ID);
  check('package.json declares All hosts in the Terminal Bridge container', declared?.name === 'All hosts', declared);
  check('…shown only when hostsCommand is set', declared?.when === 'config.terminalBridge.hostsCommand', declared);
  check('the setting is declared, empty by default',
    pkg.contributes.configuration.properties['terminalBridge.hostsCommand']?.default === '', pkg.contributes.configuration.properties);
  const view = h.treeViews.find(v => v.id === VIEW_ID);
  check('activate() registers the view', !!view, h.treeViews.map(v => v.id));
  check('the click command is registered', h.registeredCommands.has(OPEN_COMMAND));
  if (!view) process.exit(1);
  const provider = view.options.treeDataProvider;
  const headers = () => provider.getChildren().map(e => ({ e, item: provider.getTreeItem(e) }));

  view.setVisible(true);
  await wait(400);
  check('empty setting: the command never runs, even visible', runs() === 0, runs());
  view.setVisible(false);

  // ── hidden: never runs ───────────────────────────────────────────────────
  h.setConfig('hostsCommand', replay('hosts-all-up.json'));
  await wait(500);
  check('hidden: the command does not run', runs() === 0, runs());
  check('hidden: nothing to show', provider.getChildren().length === 0);

  // ── visible: runs now, then on the interval ──────────────────────────────
  view.setVisible(true);
  await wait(100);
  check('becoming visible runs it at once', runs() === 1, runs());
  let hs = headers();
  check('one header per host', JSON.stringify(hs.map(x => x.item.label)) === '["local","host-a","host-b"]', hs.map(x => x.item.label));
  check('header carries the memory line', hs[0].item.description === '1 needs a person · load 0.47 / 16 · 23 of 31 GB free · 3 of 4 workers', hs[0].item.description);
  check('a host needing a person gets the bell', hs[1].item.iconPath?.id === 'bell-dot', hs[1].item.iconPath);
  const rows = provider.getChildren(hs[0].e).map(e => provider.getTreeItem(e));
  check('its terminals are under it, Terminals-view order', JSON.stringify(rows.map(r => r.label)) === '["w-102","w-101","orch"]', rows.map(r => r.label));
  check('rows carry the status icon', rows[0].iconPath?.id === 'bell-dot', rows[0].iconPath);
  check('not stale', view.description === undefined, view.description);

  await wait(400);
  const visibleRuns = runs();
  check('while visible it re-runs on the interval', visibleRuns >= 3, visibleRuns);

  view.setVisible(false);
  await wait(50);
  const atHide = runs();
  await wait(500);
  check('hidden again: it stops', runs() === atHide, { atHide, now: runs() });

  // ── one host down: exit 2, still a document ─────────────────────────────
  h.setConfig('hostsCommand', replay('hosts-one-down.json', 2));
  view.setVisible(true);
  await wait(150);
  hs = headers();
  const b = hs.find(x => x.item.label === 'host-b');
  check('a non-zero exit with a document is a good run', view.description === undefined && hs.length === 3, view.description);
  check('the down host shows its error and last reading age', /Operation timed out · last reading \d+s ago$/.test(b?.item.description), b?.item.description);
  check('the down host is marked', b?.item.iconPath?.id === 'error', b?.item.iconPath);
  check('the others are not blanked', provider.getChildren(hs[1].e).length === 3, provider.getChildren(hs[1].e).length);

  // ── a failed run: the last good result stays, marked stale ───────────────
  h.setConfig('hostsCommand', `echo run >> '${counter}'; echo 'not json'; exit 1`);
  await wait(150);
  check('a failed run marks the view stale', /^stale · /.test(view.description ?? ''), view.description);
  check('…and keeps the last good result', headers().length === 3, headers().length);

  h.setConfig('hostsCommand', `echo run >> '${counter}'; sleep 5`);
  await wait(600);
  check('a run over the time limit is a failed run', /^stale · /.test(view.description ?? '') && headers().length === 3, view.description);

  // The hung run may still be in flight; the changed setting runs right after.
  h.setConfig('hostsCommand', replay('hosts-all-up.json'));
  await wait(600);
  check('the next good run clears stale', view.description === undefined, view.description);
  view.setVisible(false);

  // ── clicks ───────────────────────────────────────────────────────────────
  hs = headers();
  const clickOf = hostIdx => provider.getTreeItem(provider.getChildren(hs[hostIdx].e)[0]).command;
  const local = h.vscodeMock.window.createTerminal({ name: 'w-102' });
  h.executedCommands.length = 0;
  let c = clickOf(0);
  await h.registeredCommands.get(c.command)(...c.arguments);
  check('a row on this window\'s host shows the terminal',
    h.executedCommands.some(x => x.cmd === SHOW_COMMAND && x.args[0] === 'w-102') && local.shows === 1, h.executedCommands);

  h.executedCommands.length = 0;
  c = clickOf(1);
  await h.registeredCommands.get(c.command)(...c.arguments);
  const open = h.executedCommands.find(x => x.cmd === 'vscode.openFolder');
  check('a row on another host opens or focuses its window via remoteUri',
    open?.args[0]?.toString() === 'vscode-remote://ssh-remote+host-a/home/me/repo', h.executedCommands);

  h.executedCommands.length = 0;
  c = clickOf(2);
  await h.registeredCommands.get(c.command)(...c.arguments);
  check('no remoteUri: copies "<host> <terminal>"', h.clipboard.text === 'host-b w-301', h.clipboard.text);
  check('…and opens nothing', !h.executedCommands.some(x => x.cmd === 'vscode.openFolder'), h.executedCommands);

  process.exit(fails ? 1 : 0);
})();
