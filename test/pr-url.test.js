// #50 — prUrl is data plumbing only: set it, read it back via /list, last
// write wins. No polling, no GitHub knowledge inside the bridge.
const h = require('./harness');
const http = require('http');
const fs = require('fs');

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
  const row = async n =>
    JSON.parse((await get(port, '/list')).body).terminals.find(t => t.name === n);

  await get(port, '/open-terminal?name=prtab&cwd=/tmp/pr');
  await wait(50);

  check('prUrl is null before any set', (await row('prtab'))?.prUrl === null, await row('prtab'));
  check('prSetAt is null before any set', (await row('prtab'))?.prSetAt === null, await row('prtab'));

  let j = JSON.parse((await get(port, '/set-pr?name=prtab&url=https%3A%2F%2Fgithub.com%2Fx%2Fy%2Fpull%2F1')).body);
  check('set-pr returns ok', j.ok === true, j);
  check('set-pr echoes the url', j.prUrl === 'https://github.com/x/y/pull/1', j);
  check('set-pr stamps prSetAt', typeof j.prSetAt === 'string', j);

  let r = await row('prtab');
  check('list reflects the set url', r?.prUrl === 'https://github.com/x/y/pull/1', r);
  check('list reflects prSetAt', typeof r?.prSetAt === 'string', r);

  const firstSetAt = r.prSetAt;
  await wait(10);
  j = JSON.parse((await get(port, '/set-pr?name=prtab&url=https%3A%2F%2Fgithub.com%2Fx%2Fy%2Fpull%2F2')).body);
  check('a second set overwrites (last write wins)', j.prUrl === 'https://github.com/x/y/pull/2', j);

  r = await row('prtab');
  check('list reflects the overwritten url', r?.prUrl === 'https://github.com/x/y/pull/2', r);
  check('prSetAt moved forward', r?.prSetAt !== firstSetAt, { firstSetAt, now: r?.prSetAt });

  j = JSON.parse((await get(port, '/set-pr?name=nope&url=https%3A%2F%2Fgithub.com%2Fx%2Fy%2Fpull%2F3')).body);
  check('unknown name → not ok', j.ok === false, j);
  check('unknown name does not create a row', (await row('nope')) === undefined, await row('nope'));

  j = JSON.parse((await get(port, '/set-pr?name=prtab')).body);
  check('missing url param → not ok', j.ok === false, j);

  console.log(fails ? `\n${fails} failing` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
