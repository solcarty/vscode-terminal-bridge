// #6952 — merging to main publishes package.json's version, so a PR that
// changes what ships must bump it past the highest v* tag. Files .vscodeignore
// excludes (docs, tests, repo tooling, workflows) ship nothing and need no bump.
const fs = require('fs');
const path = require('path');
const vc = require('../.github/scripts/version-check');

let fails = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  → ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};

// The real .vscodeignore, so a change to it that moves these answers fails here.
const ignoreText = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
const tags = ['v0.9.0', 'v0.27.0', 'v0.26.0', 'v0.10.0'];
const run = (changed, version) => vc.check({ changed, ignoreText, version, tags });

check('highest tag is by semver, not by string', vc.highestTag(tags) === 'v0.27.0', vc.highestTag(tags));
check('0.28.0 > 0.27.0', vc.compareVersions('0.28.0', 'v0.27.0') > 0);
check('0.10.0 > 0.9.0', vc.compareVersions('0.10.0', '0.9.0') > 0);
check('equal versions compare 0', vc.compareVersions('0.27.0', 'v0.27.0') === 0);

let r = run(['extension.js'], '0.27.0');
check('extension.js change without a bump fails', r.ok === false, r);
r = run(['bin/vscode-bridge.sh'], '0.27.0');
check('bin/** change without a bump fails', r.ok === false, r);
r = run(['extension.js'], '0.26.5');
check('a version below the highest tag fails', r.ok === false, r);
r = run(['extension.js', 'README.md'], '0.27.1');
check('extension.js change with a patch bump passes', r.ok === true, r);
r = run(['package.json'], '0.27.0');
check('package.json is shipped', r.ok === false, r);

r = run(['README.md'], '0.27.0');
check('README-only change passes without a bump', r.ok === true && r.shipped.length === 0, r);
r = run(['CLAUDE.md', 'test/send.test.js', 'test/fixtures/fake-agent.js', '.claude/commands/release.md'], '0.27.0');
check('docs, tests and .claude/** pass without a bump', r.ok === true && r.shipped.length === 0, r);
r = run(['.github/workflows/release.yml', '.github/scripts/version-check.js'], '0.27.0');
check('.github/** passes without a bump', r.ok === true && r.shipped.length === 0, r);
r = run(['.vscodeignore'], '0.27.0');
check('changing .vscodeignore changes what ships, so it needs a bump', r.ok === false, r);

r = vc.check({ changed: ['extension.js'], ignoreText, version: '0.28', tags });
check('a malformed version fails', r.ok === false, r);

// Matcher semantics vsce applies: root-anchored, `*` within a segment, `!` re-includes.
const rules = vc.parseIgnore('*.md\ndocs/**\n!docs/keep.js\n# comment\n');
check('*.md matches a root md', !vc.isShipped('NOTES.md', rules));
check('*.md does not match a nested md (vsce ships it)', vc.isShipped('bin/NOTES.md', rules));
check('docs/** matches deep files', !vc.isShipped('docs/a/b.txt', rules));
check('a later ! pattern re-includes', vc.isShipped('docs/keep.js', rules));

console.log(fails ? `\n${fails} failure(s)` : '\nall green');
process.exit(fails ? 1 : 0);
