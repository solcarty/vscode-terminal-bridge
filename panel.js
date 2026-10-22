// The Terminal Bridge side panel: one TreeView row per tracked terminal, fed by
// the same registry /list serves.
//
// Tab titles are fixed at open and never carry status (see extension.js,
// "Presentation is registry data, never the tab"), so this panel is where a
// human sees status, progress and the note. The row model (`buildRows`) is
// pure — no `vscode` — so it is tested without a mock; `createPanel` is the
// thin layer that turns rows into TreeItems.

const VIEW_ID = 'terminalBridge.terminals';
const SHOW_COMMAND = 'terminalBridge.showTerminal';
const POLL_MS = 1000;

// A person is required first, then machines that are busy, then the rest.
const ATTENTION_STATES = new Set(['needs-you', 'needs-input', 'blocked', 'permission', 'error']);

function groupOf(status) {
  if (ATTENTION_STATES.has(status)) return 0;
  if (status === 'working') return 1;
  return 2;
}

// The caller's progress text: the rename label minus the name. A label that is
// just the name carries no progress; one that never mentions the name is all
// progress. Codicon prefixes (`$(bell-dot)`) are presentation, not text.
function progressText(meta, name) {
  let base = String(meta.baseLabel ?? meta.label ?? '').replace(/\$\([^)]*\)/g, '').trim();
  if (!base || base === name) return '';
  if (base.startsWith(name)) base = base.slice(name.length);
  else if (base.includes(name)) base = base.replace(name, ' ');
  return base.replace(/^[\s·:|,–—-]+/, '').replace(/\s+/g, ' ').trim();
}

function firstLine(text) {
  return String(text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
}

function formatAge(ms) {
  if (!(ms >= 0)) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Stage : a consumer-defined step, positioned in the configured order.
// A key the config doesn't list is still shown, as text with a neutral icon.
const NEUTRAL_STAGE_ICON = 'circle-outline';

function stageInfo(meta, stages) {
  if (!meta.stage) return null;
  const index = stages.findIndex(s => s.key === meta.stage);
  return { key: meta.stage, def: index >= 0 ? stages[index] : null, index, total: stages.length };
}

function stageDescription(info, meta) {
  const head = info.def ? info.def.label : info.key;
  return meta.stageDetail ? `${head} · ${meta.stageDetail}` : head;
}

// Done before the current one; the current one with its age; the rest pending.
// A `terminal` stage counts as done even when it is the current one.
function stageLines(info, meta, stages, now) {
  const age = meta.stageChangedAt ? formatAge(now - Date.parse(meta.stageChangedAt)) : null;
  const forAge = age ? ` for ${age}` : '';
  if (!info.def) return [`stage: ${info.key}${forAge}`];
  return stages.map((s, i) => {
    if (i === info.index) return s.terminal ? `✓ ${s.label}${forAge}` : `▸ ${s.label} — current${forAge}`;
    return `${i < info.index ? '✓' : '○'} ${s.label}`;
  });
}

function tooltipFor(meta, now, info, stages) {
  const status = meta.status ?? 'none';
  const age = meta.statusChangedAt ? formatAge(now - Date.parse(meta.statusChangedAt)) : null;
  const lines = [];
  if (info) lines.push(...stageLines(info, meta, stages, now), '');
  lines.push(age ? `${status} for ${age}` : status);
  const pending = Number(meta.pendingTasks) || 0;
  if (pending > 0) lines.push(`background tasks: ${pending}`);
  if (meta.note) lines.push('', String(meta.note).trim(), '');
  if (meta.cmdDelivery) lines.push(`cmd: ${meta.cmdDelivery}`);
  if (meta.prUrl) lines.push(`PR: ${meta.prUrl}`);
  if (meta.node) lines.push(`node: ${meta.node}`);
  return lines.join('\n').replace(/\n+$/, '');
}

function createdMs(meta) {
  const t = Date.parse(meta.createdAt ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

// Registry rows → ordered panel rows. `isLive(name)` is /list's `live`: a row
// whose terminal is gone is dropped here, so it leaves the panel on the next
// refresh even before anything deletes it from the registry.
function buildRows(metadata, { statusMap, displayStatusKey, isLive = () => true, now = Date.now(), stages = [] }) {
  return Object.entries(metadata ?? {})
    .filter(([name]) => isLive(name))
    .map(([name, meta]) => {
      const key = displayStatusKey(meta);
      const cfg = key ? (statusMap[key] ?? null) : null;
      const info = stageInfo(meta, stages);
      // The stage owns the icon unless a person is needed: needs-input,
      // permission and error keep their own, and the colour is the status's.
      const stageIcon = info && !ATTENTION_STATES.has(key) ? (info.def?.codicon ?? NEUTRAL_STAGE_ICON) : null;
      return {
        name,
        label: name,
        description: info ? stageDescription(info, meta) : progressText(meta, name) || firstLine(meta.note),
        stage: info ? info.key : null,
        status: meta.status ?? null,
        displayStatus: key ?? null,
        codicon: stageIcon ?? (cfg ? cfg.codicon : null),
        color: cfg ? cfg.color : null,
        tooltip: tooltipFor(meta, now, info, stages),
        group: groupOf(meta.status ?? null),
        createdAt: meta.createdAt ?? null,
        _created: createdMs(meta),
      };
    })
    .sort((a, b) => a.group - b.group || b._created - a._created || a.name.localeCompare(b.name))
    .map(({ _created, ...row }) => row);
}

// `deps`: loadMetadata(), statusMap, displayStatusKey, terminals (the bridge's
// name → Terminal map), onDidWrite(listener) for registry writes.
//
// `deps.source()` (#77), when it returns something, replaces the local
// registry: a window deferring to a headless bridge shows that bridge's rows
// ({ metadata, isLive(name), show(name) }) and has no untracked group, because
// its own tabs are viewers, not terminals the bridge runs.
function createPanel(vscode, context, deps) {
  const { loadMetadata, statusMap, displayStatusKey, terminals, onDidWrite, source = () => null, getStages = () => [] } = deps;
  const changed = new vscode.EventEmitter();
  let pollTimer = null;
  let untracked = [];

  const isLive = name => terminals.has(name) || vscode.window.terminals.some(t => t.name === name);
  const terminalFor = name => terminals.get(name) ?? vscode.window.terminals.find(t => t.name === name);

  function readRows() {
    const remote = source();
    if (remote) {
      untracked = [];
      return buildRows(remote.metadata, { statusMap, displayStatusKey, isLive: remote.isLive, stages: remote.stages ?? [] });
    }
    const rows = buildRows(loadMetadata(), { statusMap, displayStatusKey, isLive, stages: getStages() });
    const bound = new Set(terminals.values());
    untracked = vscode.window.terminals.filter(t => !bound.has(t));
    return rows;
  }

  // Re-read once a second only while something is working; otherwise the
  // panel is purely event-driven.
  function schedule(rows) {
    const working = rows.some(r => r.status === 'working');
    if (working && !pollTimer) {
      pollTimer = setTimeout(() => { pollTimer = null; refresh(); }, POLL_MS);
    } else if (!working && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function refresh() { changed.fire(undefined); }

  function rowItem(row) {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = `tracked:${row.name}`;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.contextValue = 'trackedTerminal';
    if (row.codicon) {
      item.iconPath = new vscode.ThemeIcon(row.codicon, row.color ? new vscode.ThemeColor(row.color) : undefined);
    }
    item.command = { command: SHOW_COMMAND, title: 'Show terminal', arguments: [row.name] };
    return item;
  }

  function untrackedItem(terminal, i) {
    const item = new vscode.TreeItem(terminal.name, vscode.TreeItemCollapsibleState.None);
    item.id = `untracked:${i}:${terminal.name}`;
    item.tooltip = 'Not tracked by the bridge';
    item.contextValue = 'untrackedTerminal';
    item.iconPath = new vscode.ThemeIcon('terminal');
    item.command = { command: SHOW_COMMAND, title: 'Show terminal', arguments: [terminal] };
    return item;
  }

  const UNTRACKED_GROUP = { kind: 'untracked-group' };

  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren(element) {
      if (element === UNTRACKED_GROUP) return untracked.map((t, i) => ({ kind: 'untracked', terminal: t, i }));
      if (element) return [];
      const rows = readRows();
      schedule(rows);
      const children = rows.map(row => ({ kind: 'row', row }));
      if (untracked.length) children.push(UNTRACKED_GROUP);
      return children;
    },
    getTreeItem(element) {
      if (element.kind === 'row') return rowItem(element.row);
      if (element.kind === 'untracked') return untrackedItem(element.terminal, element.i);
      const item = new vscode.TreeItem(`Untracked (${untracked.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'untracked-group';
      item.contextValue = 'untrackedGroup';
      return item;
    },
  };

  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider });
  context.subscriptions.push(view, changed);

  context.subscriptions.push(vscode.commands.registerCommand(SHOW_COMMAND, target => {
    const remote = source();
    if (remote && typeof target === 'string') return remote.show(target);
    const terminal = typeof target === 'string' ? terminalFor(target) : target;
    if (terminal) terminal.show();
  }));

  context.subscriptions.push(onDidWrite(refresh));
  for (const event of ['onDidOpenTerminal', 'onDidCloseTerminal']) {
    if (typeof vscode.window[event] === 'function') {
      context.subscriptions.push(vscode.window[event](refresh));
    }
  }
  context.subscriptions.push({ dispose: () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; } });

  return { view, provider, refresh };
}

module.exports = { VIEW_ID, SHOW_COMMAND, POLL_MS, buildRows, progressText, formatAge, createPanel };
