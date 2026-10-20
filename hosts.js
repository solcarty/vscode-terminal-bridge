// The All hosts view: every host's terminals at once, fed by the JSON that
// `terminalBridge.hostsCommand` prints, not by this bridge's registry.
//
// The bridge knows only the JSON contract (README, "All hosts view"); it names
// no host and reaches none. The command does the reaching, and the view sends
// nothing anywhere. Like panel.js, the model (`buildHosts`, `readingLine`) is
// pure so it is tested against recorded JSON; `createHostsPanel` is the thin
// TreeView and poller around it.

const { spawn } = require('child_process');
const os = require('os');
const { buildRows, formatAge } = require('./panel');

const VIEW_ID = 'terminalBridge.hosts';
const OPEN_COMMAND = 'terminalBridge.openHostTerminal';
const SETTING = 'hostsCommand';
const INTERVAL_MS = Number(process.env.VSCODE_BRIDGE_HOSTS_INTERVAL_MS) || 30000;
const TIMEOUT_MS = Number(process.env.VSCODE_BRIDGE_HOSTS_TIMEOUT_MS) || 20000;
const ATTENTION_STATES = new Set(['needs-you', 'needs-input', 'blocked', 'permission', 'error']);

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// `load 0.47 / 16 · 23 of 31 GB free · 3 of 4 workers`, leaving out what the
// host did not report. Empty when it reported nothing.
function readingLine(h) {
  const parts = [];
  if (isNum(h.load)) parts.push(`load ${h.load}` + (isNum(h.cpus) ? ` / ${h.cpus}` : ''));
  else if (isNum(h.cpus)) parts.push(`${h.cpus} cpus`);
  if (isNum(h.memAvailableGb) && isNum(h.memTotalGb)) {
    parts.push(`${Math.round(h.memAvailableGb)} of ${Math.round(h.memTotalGb)} GB free`);
  }
  if (isNum(h.workers)) parts.push(`${h.workers}` + (isNum(h.workerCap) ? ` of ${h.workerCap}` : '') + ' workers');
  return parts.join(' · ');
}

// The command's stdout → the document, or why it isn't one. Exit status is not
// consulted: a producer may exit non-zero to say a host is down and still
// print a complete document, which is exactly the case this view must show.
function parseHostsDoc(stdout) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { return { error: 'output is not JSON' }; }
  if (!doc || !Array.isArray(doc.hosts)) return { error: 'output has no hosts array' };
  const hosts = doc.hosts.filter(h => h && typeof h.name === 'string' && h.name);
  return { doc: { hosts } };
}

// Remember each host's last good entry, so a host that stops answering still
// shows when it last did. Mutates and returns `lastGood` (name → {at, entry}).
function recordGood(lastGood, doc, at) {
  for (const h of doc?.hosts ?? []) {
    if (h.ok === true) lastGood[h.name] = { at, entry: h };
  }
  return lastGood;
}

// One header per host, in the document's order, with its terminals as rows
// built exactly like the Terminals view's (same shape, same order). A host
// that did not answer keeps its last good reading and terminals, with its
// error and that reading's age; one host down never blanks another.
function buildHosts(doc, { statusMap, displayStatusKey, now = Date.now(), lastGood = {} }) {
  return (doc?.hosts ?? []).map(h => {
    const ok = h.ok === true;
    const good = ok ? { at: now, entry: h } : (lastGood[h.name] ?? null);
    const source = good?.entry ?? h;
    const metadata = {};
    for (const t of Array.isArray(source.terminals) ? source.terminals : []) {
      if (t && typeof t.name === 'string' && t.live !== false) metadata[t.name] = t;
    }
    const rows = buildRows(metadata, { statusMap, displayStatusKey, now });
    const attention = rows.filter(r => ATTENTION_STATES.has(r.status)).length;
    const reading = readingLine(source);
    let description;
    if (ok) {
      description = reading;
    } else {
      const age = good ? formatAge(now - good.at) : null;
      description = [h.error ? String(h.error) : 'did not answer',
        age ? `last reading ${age} ago` : 'no reading yet'].join(' · ');
    }
    if (attention) description = `${attention} need${attention === 1 ? 's' : ''} a person · ${description}`;
    return {
      name: h.name,
      self: h.self === true,
      ok,
      error: ok ? null : (h.error ?? null),
      reading,
      description,
      attention,
      remoteUri: typeof h.remoteUri === 'string' && h.remoteUri ? h.remoteUri : null,
      lastGoodAt: good ? good.at : null,
      rows,
    };
  });
}

// Run the command through a shell with a time limit. Killed as a process group
// on timeout, so an SSH child left behind by a hung host goes with it.
function runHostsCommand(command, { timeoutMs = TIMEOUT_MS, cwd = os.homedir() } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ error: `could not run: ${err.message}` });
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { if (err.length < 4096) err += c; });
    child.on('error', e => { clearTimeout(timer); resolve({ error: `could not run: ${e.message}` }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return resolve({ error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      const parsed = parseHostsDoc(out);
      if (parsed.doc) return resolve(parsed);
      const why = err.trim().split('\n').pop();
      resolve({ error: `${parsed.error} (exit ${code}${why ? `: ${why}` : ''})` });
    });
  });
}

// `deps`: statusMap, displayStatusKey, getCommand() (the setting, trimmed),
// showLocal(name) for this window's own terminals, run (defaults to
// runHostsCommand; tests inject it).
function createHostsPanel(vscode, context, deps) {
  const { statusMap, displayStatusKey, getCommand, showLocal, run = runHostsCommand } = deps;
  const changed = new vscode.EventEmitter();
  const lastGood = {};
  let doc = null;          // last good document
  let fetchedAt = null;    // when it was read
  let failure = null;      // the last run's error, when it failed
  let timer = null;
  let running = null;
  let rerun = false;       // a poll asked for while one was in flight
  let view = null;

  function render() {
    if (view) {
      view.description = failure && doc ? `stale · ${formatAge(Date.now() - fetchedAt)} old` : undefined;
      view.message = failure && !doc ? `hostsCommand failed: ${failure}` : undefined;
    }
    changed.fire(undefined);
  }

  async function poll() {
    const command = getCommand();
    if (!command) return null;
    // One run at a time; a request made meanwhile (a changed setting) runs
    // as soon as the current one ends, not a whole interval later.
    if (running) { rerun = true; return running; }
    running = (async () => {
      const result = await run(command, { timeoutMs: TIMEOUT_MS });
      if (result.doc) {
        doc = result.doc;
        fetchedAt = Date.now();
        failure = null;
        recordGood(lastGood, doc, fetchedAt);
      } else {
        failure = result.error ?? 'failed';
      }
      render();
    })().finally(() => {
      running = null;
      if (rerun) { rerun = false; if (timer) poll(); }
    });
    return running;
  }

  // Runs only while the view is on screen: once on becoming visible, then
  // every INTERVAL_MS. Hidden, or with no command set, nothing runs.
  function sync() {
    const active = !!view?.visible && !!getCommand();
    if (active && !timer) {
      poll();
      timer = setInterval(poll, INTERVAL_MS);
    } else if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren(element) {
      if (element?.kind === 'host') return element.host.rows.map(row => ({ kind: 'row', host: element.host, row }));
      if (element) return [];
      if (!doc) return [];
      return buildHosts(doc, { statusMap, displayStatusKey, lastGood }).map(host => ({ kind: 'host', host }));
    },
    getTreeItem(element) {
      if (element.kind === 'host') {
        const { host } = element;
        const item = new vscode.TreeItem(host.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `host:${host.name}`;
        item.description = host.description;
        item.tooltip = [host.name + (host.self ? ' (this window)' : ''), host.reading,
          host.ok ? null : `did not answer: ${host.error ?? 'unknown'}`].filter(Boolean).join('\n');
        item.contextValue = host.ok ? 'host' : 'hostDown';
        item.iconPath = !host.ok
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('terminal.ansiRed'))
          : host.attention
            ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('terminal.ansiYellow'))
            : new vscode.ThemeIcon('server');
        return item;
      }
      const { host, row } = element;
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
      item.id = `host:${host.name}:${row.name}`;
      item.description = row.description;
      item.tooltip = row.tooltip;
      item.contextValue = 'hostTerminal';
      if (row.codicon) {
        item.iconPath = new vscode.ThemeIcon(row.codicon, row.color ? new vscode.ThemeColor(row.color) : undefined);
      }
      item.command = { command: OPEN_COMMAND, title: 'Open terminal',
        arguments: [{ host: host.name, self: host.self, remoteUri: host.remoteUri, terminal: row.name }] };
      return item;
    },
  };

  view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider });
  context.subscriptions.push(view, changed);

  // This window's host: show the terminal. Another host: open or focus its
  // window. No way to reach it: copy the names so a person can.
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_COMMAND, async target => {
    if (!target) return;
    if (target.self) return showLocal(target.terminal);
    if (target.remoteUri) {
      return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(target.remoteUri), { forceNewWindow: true });
    }
    const text = `${target.host} ${target.terminal}`;
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`Copied "${text}"`);
  }));

  if (typeof view.onDidChangeVisibility === 'function') {
    context.subscriptions.push(view.onDidChangeVisibility(sync));
  }
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`terminalBridge.${SETTING}`)) {
        if (timer) { clearInterval(timer); timer = null; }
        sync();
      }
    }));
  }
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); timer = null; } });
  sync();

  return { view, provider, poll, sync };
}

module.exports = {
  VIEW_ID, OPEN_COMMAND, SETTING, INTERVAL_MS, TIMEOUT_MS,
  readingLine, parseHostsDoc, recordGood, buildHosts, runHostsCommand, createHostsPanel,
};
