const vscode = require('vscode');
const http = require('http');

let server;

// Stable registry: creation key → terminal instance.
// Survives display name changes.
const terminals = new Map();

function activate(context) {
  // Clean up registry when the user closes a terminal manually.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(closed => {
      for (const [key, t] of terminals) {
        if (t === closed) { terminals.delete(key); break; }
      }
    })
  );

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/open-terminal') {
      const cwd     = url.searchParams.get('cwd')   || undefined;
      const name    = url.searchParams.get('name')  || undefined;
      const cmd     = url.searchParams.get('cmd')   || undefined;

      // color — reserved for future status indicators
      // e.g. 'terminal.ansiGreen' (done), 'terminal.ansiRed' (blocked)
      const colorId = url.searchParams.get('color') || undefined;

      // icon — reserved for future status icons
      // e.g. 'check', 'error', 'sync~spin'
      const iconId  = url.searchParams.get('icon')  || undefined;

      const options = { cwd, name };
      if (colorId) options.color    = new vscode.ThemeColor(colorId);
      if (iconId)  options.iconPath = new vscode.ThemeIcon(iconId);

      const terminal = vscode.window.createTerminal(options);
      terminal.show(false);
      if (cmd) terminal.sendText(cmd);
      if (name) terminals.set(name, terminal);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, cwd, cmd, color: colorId, icon: iconId }));

    } else if (url.pathname === '/rename-terminal') {
      // Rename a terminal tab via VS Code API — no OSC sequences needed.
      // Called by Claude Code hooks (PreToolUse/Notification/Stop) to show live status.
      //
      // Optional icon + color params update the tab's visual state alongside the label:
      //   PreToolUse:  icon=sync~spin  color=terminal.ansiCyan
      //   Notification: icon=bell      color=terminal.ansiYellow
      //   Stop:         icon=check     color=terminal.ansiGreen
      const name    = url.searchParams.get('name');
      const label   = url.searchParams.get('label');
      const colorId = url.searchParams.get('color') || undefined;
      const iconId  = url.searchParams.get('icon')  || undefined;
      const terminal = name && terminals.get(name);

      if (!terminal) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      if (!label) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'label param required' }));
        return;
      }

      // Only switch the active terminal if needed — renameWithArg targets the active one.
      // Use show(true) = preserveFocus so keyboard focus is NEVER stolen from the editor.
      const prev = vscode.window.activeTerminal;
      const needsSwitch = prev !== terminal;
      if (needsSwitch) terminal.show(true);
      await vscode.commands.executeCommand(
        'workbench.action.terminal.renameWithArg',
        { name: label }
      );
      if (needsSwitch && prev) prev.show(true);

      // Update icon and color if provided
      if (iconId)  terminal.iconPath = new vscode.ThemeIcon(iconId);
      if (colorId) terminal.color    = new vscode.ThemeColor(colorId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, label, icon: iconId, color: colorId }));

    } else if (url.pathname === '/close-terminal') {
      const name = url.searchParams.get('name');
      const terminal = name && terminals.get(name);

      if (!terminal) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Terminal not found', name }));
        return;
      }

      terminal.dispose();
      terminals.delete(name);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name }));

    } else if (url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ipcHook: process.env.VSCODE_IPC_HOOK || null,
        pid: process.env.VSCODE_PID ? Number(process.env.VSCODE_PID) : null,
      }));

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(31415, '127.0.0.1', () => {
    console.log('[terminal-bridge] listening on 127.0.0.1:31415');
  });

  server.on('error', (err) => {
    console.error('[terminal-bridge] server error:', err.message);
  });

  context.subscriptions.push({ dispose: () => server && server.close() });
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
