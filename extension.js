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
      // Called by Claude Code hooks (PreToolUse/Stop) to show live status:
      //   curl "http://127.0.0.1:31415/rename-terminal?name=SOL-60&label=SOL-60%20[%E2%9A%99%20working]"
      const name  = url.searchParams.get('name');
      const label = url.searchParams.get('label');
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

      // Make the target terminal active, rename it, restore previous active.
      // Wait one event-loop tick after show() so VS Code registers the focus
      // change before we fire renameWithArg (which targets the active terminal).
      const prev = vscode.window.activeTerminal;
      terminal.show(false);
      await new Promise(r => setTimeout(r, 80));
      await vscode.commands.executeCommand(
        'workbench.action.terminal.renameWithArg',
        { name: label }
      );
      if (prev && prev !== terminal) prev.show(false);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, label }));

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
      res.writeHead(200);
      res.end('pong');

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
