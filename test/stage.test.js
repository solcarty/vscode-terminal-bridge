// a consumer-defined stage per terminal: set, read back in /list,
// change, clear; unlisted keys are stored, not rejected; the configured list
// rides on /list so a deferring window renders the same steps.
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
  const list = async () => JSON.parse((await get(port, '/list')).body);
  const row = async n => (await list()).terminals.find(t => t.name === n);
  const call = async p => { const r = await get(port, p); return { code: r.code, ...JSON.parse(r.body) }; };

  await get(port, '/open-terminal?name=st&cwd=/tmp/st');
  await wait(50);

  let r = await row('st');
  check('a terminal that never set a stage reports nulls',
    r.stage === null && r.stageDetail === null && r.stageChangedAt === null, r);
  check('no stages configured → /list carries an empty list', (await list()).stages.length === 0, await list());

  let j = await call('/set-stage?name=st&key=review&detail=PR%20%2312');
  check('set-stage returns ok and echoes the fields', j.ok && j.stage === 'review' && j.stageDetail === 'PR #12' && !!j.stageChangedAt, j);
  r = await row('st');
  check('/list returns stage, detail and changedAt', r.stage === 'review' && r.stageDetail === 'PR #12' && r.stageChangedAt === j.stageChangedAt, r);

  await wait(20);
  j = await call('/set-stage?name=st&key=review&detail=PR%20%2313');
  check('same key, new detail → detail moves, changedAt does not',
    j.stageDetail === 'PR #13' && j.stageChangedAt === r.stageChangedAt, j);
  await wait(20);
  j = await call('/set-stage?name=st&key=merged');
  check('a new key moves changedAt and drops the old detail',
    j.stage === 'merged' && j.stageDetail === null && j.stageChangedAt !== r.stageChangedAt, j);

  j = await call('/set-stage?name=st&clear=1');
  r = await row('st');
  check('clear nulls all three fields', j.ok && r.stage === null && r.stageDetail === null && r.stageChangedAt === null, r);

  j = await call('/set-stage?name=nope&key=x');
  check('unknown terminal → 404', j.code === 404 && j.ok === false, j);
  j = await call('/set-stage?name=st');
  check('missing key → 400', j.code === 400, j);

  h.vscodeMock._config.stages = [
    { key: 'build', label: 'Build', codicon: 'tools' },
    { key: 'merged', label: 'Merged', codicon: 'git-merge', terminal: true },
    { key: 'bad key', label: 'x', codicon: 'not valid!' },
    { label: 'no key' },
  ];
  const stages = (await list()).stages;
  check('configured stages are normalized and listed in order',
    stages.length === 3 && stages[0].key === 'build' && stages[1].terminal === true, stages);
  check('an invalid codicon is dropped, the stage kept', stages[2].key === 'bad key' && stages[2].codicon === undefined, stages);

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
  process.exit(fails ? 1 : 0);
})();
