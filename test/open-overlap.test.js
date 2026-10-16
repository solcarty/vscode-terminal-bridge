// #6944 — overlapping opens for one name produce one terminal, and an icon
// that isn't a codicon id is dropped and reported, never shown as `$(…)` text.
process.env.VSCODE_BRIDGE_CMD_FALLBACK_MS = '120';   // must precede harness load

const h = require('./harness');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Record what each terminal was created with, so the icon actually handed to
// VS Code can be checked rather than inferred from the response.
const created = [];
const origCreate = h.vscodeMock.window.createTerminal;
h.vscodeMock.window.createTerminal = (options) => {
  created.push(options);
  return origCreate(options);
};

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
  const open = async q => JSON.parse((await get(port, `/open-terminal?${q}`)).body);

  // A worker node that takes a while to accept a job: the window between an
  // open being received and its terminal existing. `failNext` makes the next
  // /run-job fail, to model a first open that never creates anything.
  let runJobs = 0, failNext = false;
  const worker = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      runJobs++;
      const fail = failNext; failNext = false;
      setTimeout(() => {
        res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !fail }));
      }, 300);
    });
  });
  await new Promise(r => worker.listen(0, '127.0.0.1', r));
  const nodesDir = path.join(process.env.HOME, '.vscode-terminal-bridge');
  fs.mkdirSync(nodesDir, { recursive: true });
  fs.writeFileSync(path.join(nodesDir, 'nodes.json'), JSON.stringify({
    slow: { host: '127.0.0.1', port: worker.address().port, token: 't' },
  }));

  // ── two overlapping opens for one name ──────────────────────────────────
  const q = 'name=dup&cwd=/tmp/a&cmd=run-it&node=slow';
  const [a, b] = await Promise.all([open(q), open(q)]);
  check('two overlapping opens create exactly one terminal', h.countTerminals('dup') === 1, h.countTerminals('dup'));
  check('one open created it', [a, b].filter(j => j.ok && j.reused === false).length === 1, [a, b]);
  check('the other waited and reused it', [a, b].filter(j => j.ok && j.reused === true).length === 1, [a, b]);
  check('the reused open did not start a second job', runJobs === 1, runJobs);

  const [c, d] = await Promise.all([open('name=local&cwd=/tmp/b'), open('name=local&cwd=/tmp/b')]);
  check('overlapping local opens create one terminal too',
    h.countTerminals('local') === 1 && [c, d].some(j => j.reused === true), [c, d]);

  // A first open that fails makes nothing; the one waiting on it creates.
  failNext = true;
  const [e, f] = await Promise.all([open('name=retry&cwd=/tmp/c&cmd=x&node=slow'), open('name=retry&cwd=/tmp/c&cmd=x&node=slow')]);
  check('a waiter whose first open failed creates the terminal itself',
    h.countTerminals('retry') === 1 && [e, f].some(j => j.ok === false) && [e, f].some(j => j.ok && j.reused === false), [e, f]);

  worker.close();

  // ── icons ────────────────────────────────────────────────────────────────
  created.length = 0;
  const emoji = '🛰️';
  let j = await open(`name=sat&cwd=/tmp/d&icon=${encodeURIComponent(emoji)}`);
  check('an emoji icon still opens the terminal', j.ok && h.countTerminals('sat') === 1, j);
  check('an emoji icon is reported as iconIgnored', j.iconIgnored === emoji, j);
  check('an emoji icon is not echoed as the icon', j.icon == null, j);
  check('an emoji icon is never handed to VS Code', created[0] && created[0].iconPath === undefined, created[0]);
  check('the title carries no $(…) text', !/\$\(/.test(h.findTerminal('sat').name), h.findTerminal('sat').name);

  j = await open(`name=dollar&cwd=/tmp/e&icon=${encodeURIComponent('$(hubot)')}`);
  check('a $(…) wrapped icon is ignored too', j.iconIgnored === '$(hubot)' && created[1].iconPath === undefined, j);

  for (const [i, icon] of [['hubot', 'hubot'], ['spin', 'sync~spin']].entries()) {
    j = await open(`name=ok-${icon[0]}&cwd=/tmp/f&icon=${encodeURIComponent(icon[1])}`);
    check(`codicon id "${icon[1]}" is applied`,
      j.icon === icon[1] && j.iconIgnored === undefined && created[2 + i].iconPath?.id === icon[1], { j, opts: created[2 + i] });
  }

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
