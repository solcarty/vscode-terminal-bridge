const vscode = require('vscode');
const http = require('http');

let server;

function activate(context) {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/open-terminal') {
      const cwd  = url.searchParams.get('cwd')  || undefined;
      const cmd  = url.searchParams.get('cmd')  || undefined;
      const name = url.searchParams.get('name') || undefined;

      const terminal = vscode.window.createTerminal({ cwd, name });
      terminal.show(false); // open panel without stealing editor focus
      if (cmd) terminal.sendText(cmd);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, cwd, cmd }));

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
