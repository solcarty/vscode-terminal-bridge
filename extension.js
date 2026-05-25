const vscode = require('vscode');
const http = require('http');

let server;

// Stable registry: creation key → terminal instance.
// Survives OSC-driven display name changes inside the terminal process.
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

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/open-terminal') {
      const cwd  = url.searchParams.get('cwd')  || undefined;
      const cmd  = url.searchParams.get('cmd')  || undefined;
      const name = url.searchParams.get('name') || undefined;

      const terminal = vscode.window.createTerminal({ cwd, name });
      terminal.show(false); // open panel without stealing editor focus
      if (cmd) terminal.sendText(cmd);

      if (name) terminals.set(name, terminal);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, cwd, cmd }));

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
