// #6943 — activate() registers the Terminal Bridge side panel, and the panel is
// wired to the real registry: a write refreshes it, a row's click shows its
// terminal, an unbound tab lands in Untracked, and a 1s re-read runs only
// while something is working.
// /open-terminal's blind-delivery fallback stamps cmdDelivery 5s after an open;
// that is a real registry write, so shorten it to keep it out of the poll
// counts below. Read at load time, so it has to be set before the require.
process.env.VSCODE_BRIDGE_CMD_FALLBACK_MS = '100';
const h = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { VIEW_ID, SHOW_COMMAND, POLL_MS } = require('../panel');

h.ext.activate(h.context);

const get = (port, p) => new Promise(res => {
  http.get(`http://127.0.0.1:${port}${p}`, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
  });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await wait(100);
    try { port = fs.readFileSync(h.portFile, 'utf8').trim(); } catch { /* not up yet */ }
  }
  if (!port) { console.log('FAIL  bridge never wrote a port file'); process.exit(1); }

  let fails = 0;
  const check = (label, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
    if (!cond) fails++;
  };

  // ── registration ──────────────────────────────────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = Object.values(pkg.contributes.views ?? {}).flat().map(v => v.id);
  const container = (pkg.contributes.viewsContainers?.activitybar ?? []).find(c => c.title === 'Terminal Bridge');
  check('package.json declares a Terminal Bridge activity-bar container', !!container, pkg.contributes.viewsContainers);
  check('the view lives in that container', (pkg.contributes.views?.[container?.id] ?? []).some(v => v.id === VIEW_ID), pkg.contributes.views);
  check('the container icon ships', !!container && fs.existsSync(path.join(__dirname, '..', container.icon)), container);
  const view = h.treeViews.find(v => v.id === VIEW_ID);
  check('activate() registers the declared tree view', !!view && declared.includes(VIEW_ID), h.treeViews.map(v => v.id));
  check('the show command is registered', h.registeredCommands.has(SHOW_COMMAND), [...h.registeredCommands.keys()]);
  if (!view) process.exit(1);

  const provider = view.options.treeDataProvider;
  // VS Code re-reads the tree whenever the provider fires; do the same, or a
  // poll that re-arms from getChildren() would look like it stopped.
  let fired = 0;
  provider.onDidChangeTreeData(() => { fired++; provider.getChildren(); });
  const top = () => provider.getChildren();
  const items = () => top().map(e => provider.getTreeItem(e));

  // ── rows from the registry ────────────────────────────────────────────────
  let before = fired;
  await get(port, '/open-terminal?name=alpha&cwd=/tmp/a');
  await wait(50);
  check('a registry write refreshes the view', fired > before, { before, fired });

  await get(port, '/open-terminal?name=beta&cwd=/tmp/b');
  await wait(50);
  await get(port, '/rename-terminal?name=beta&status=needs-input&label=' + encodeURIComponent('beta 3/5 reviewing'));
  await get(port, '/rename-terminal?name=alpha&status=idle');
  await wait(50);

  let it = items();
  check('one row per tracked terminal, attention first', JSON.stringify(it.map(i => i.label)) === '["beta","alpha"]', it.map(i => i.label));
  const beta = it[0];
  check('row icon is the STATUS_MAP codicon', beta.iconPath?.id === 'bell-dot', beta.iconPath);
  check('row icon carries the STATUS_MAP color', beta.iconPath?.color?.id === 'terminal.ansiYellow', beta.iconPath);
  check('row description is the progress text', beta.description === '3/5 reviewing', beta.description);
  check('row tooltip leads with the status', String(beta.tooltip).startsWith('needs-input'), beta.tooltip);

  before = fired;
  await get(port, '/set-note?name=alpha&text=' + encodeURIComponent('shipped: pr=7\nmore'));
  await wait(20);
  check('a note write refreshes the view', fired > before, { before, fired });
  check('note first line is the description when there is no progress',
    items().find(i => i.label === 'alpha').description === 'shipped: pr=7', items().map(i => i.description));

  // ── click ─────────────────────────────────────────────────────────────────
  const alphaTerm = h.findTerminal('alpha');
  const shows = alphaTerm.shows;
  const alphaItem = items().find(i => i.label === 'alpha');
  await h.registeredCommands.get(alphaItem.command.command)(...alphaItem.command.arguments);
  check('clicking a row shows that terminal', alphaTerm.shows === shows + 1, { shows: alphaTerm.shows });

  // ── untracked ─────────────────────────────────────────────────────────────
  const stray = h.addTerminal(h.makeTerminal('stray-shell', 9999));
  const group = top().find(e => provider.getTreeItem(e).label.startsWith('Untracked'));
  check('an untracked tab gets a collapsed Untracked group', !!group && provider.getTreeItem(group).collapsibleState === h.vscodeMock.TreeItemCollapsibleState.Collapsed, items().map(i => i.label));
  const kids = group ? provider.getChildren(group).map(e => provider.getTreeItem(e)) : [];
  check('…listing the stray tab', kids.length === 1 && kids[0].label === 'stray-shell', kids.map(k => k.label));
  if (kids[0]) await h.registeredCommands.get(SHOW_COMMAND)(...kids[0].command.arguments);
  check('clicking an untracked row shows it', stray.shows === 1, { shows: stray.shows });

  // ── gone ──────────────────────────────────────────────────────────────────
  await h.closeTerminal(h.findTerminal('beta'));
  await wait(20);
  check('a closed terminal drops on the next refresh', !items().some(i => i.label === 'beta'), items().map(i => i.label));

  // ── polling only while working ────────────────────────────────────────────
  // Let activation's deferred reindex/sweep (2.5s) settle so their registry
  // writes aren't counted as polls.
  await wait(3000);
  await get(port, '/rename-terminal?name=alpha&status=working');
  await wait(20);
  before = fired;
  await wait(POLL_MS * 2.5);
  check('re-reads about once a second while a row is working', fired - before >= 2 && fired - before <= 3, fired - before);

  await get(port, '/rename-terminal?name=alpha&status=idle');
  await wait(POLL_MS * 1.5);  // a re-read already in flight may land once
  before = fired;
  await wait(POLL_MS * 2.5);
  check('no polling once nothing is working', fired === before, fired - before);

  process.exit(fails ? 1 : 0);
})();
