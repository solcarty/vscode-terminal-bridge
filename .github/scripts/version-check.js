#!/usr/bin/env node
// version-check — a PR that changes what ships must bump package.json's version
// past the highest v* tag, because merging to main publishes that version
// (.github/workflows/release.yml). A PR that only touches files .vscodeignore
// excludes (docs, tests, repo tooling) ships nothing and needs no bump.
//
// Dependency-free on purpose: CI runs it before anything is installed.
//
//   node .github/scripts/version-check.js --base <sha> --head <sha>
//   node .github/scripts/version-check.js --since-tag [--head <sha>]
//
// --since-tag checks the state of a branch rather than a PR: it diffs the
// highest v* tag against head, so shipped changes that reached main without a
// bump (a direct push, a merge race, a PR that skipped the check) fail too.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// One .vscodeignore glob → RegExp, with the minimatch semantics vsce applies:
// `*` and `?` stay inside a path segment, `**` spans segments, dotfiles match,
// and a pattern without a slash matches from the package root only.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function parseIgnore(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const negate = l.startsWith('!');
      const glob = (negate ? l.slice(1) : l).replace(/^\//, '').replace(/\/$/, '/**');
      return { negate, re: globToRegExp(glob) };
    });
}

// A file ships unless .vscodeignore excludes it; the last matching pattern wins.
// .vscodeignore itself never lands in the VSIX, but changing it changes what
// does, so it counts as shipped.
function isShipped(file, rules) {
  if (file === '.vscodeignore') return true;
  let ignored = false;
  for (const { negate, re } of rules) {
    if (re.test(file)) ignored = !negate;
  }
  return !ignored;
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function highestTag(tags) {
  return tags.filter(t => /^v/.test(t) && parseVersion(t))
    .sort(compareVersions)
    .pop() || null;
}

// The verdict, separated from git so the test can drive it directly.
function check({ changed, ignoreText, version, tags }) {
  const rules = parseIgnore(ignoreText);
  const shipped = changed.filter(f => isShipped(f, rules));
  const latest = highestTag(tags);
  if (!shipped.length) {
    return { ok: true, shipped, latest, reason: 'no shipped files changed; no version bump needed' };
  }
  if (!parseVersion(version)) {
    return { ok: false, shipped, latest, reason: `package.json version "${version}" is not MAJOR.MINOR.PATCH` };
  }
  if (latest && compareVersions(version, latest) <= 0) {
    return {
      ok: false, shipped, latest,
      reason: `shipped files changed but package.json version ${version} is not greater than ${latest}. ` +
        'Bump "version" in package.json: patch for a fix, minor for new behaviour or a new endpoint.',
    };
  }
  return { ok: true, shipped, latest, reason: `version ${version} is greater than ${latest || 'any tag'}` };
}

function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since-tag') { args.sinceTag = true; continue; }
    const m = /^--(base|head)(?:=(.*))?$/.exec(argv[i]);
    if (m) args[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
  if (args.sinceTag) {
    args.head = args.head || 'HEAD';
    args.base = highestTag(git('tag', '-l', 'v*').split('\n').filter(Boolean));
    if (!args.base) { console.log('ok: no v* tag yet; nothing to compare against'); return; }
  }
  if (!args.base || !args.head) {
    console.error('usage: version-check.js --base <sha> --head <sha> | --since-tag [--head <sha>]');
    process.exit(2);
  }
  const root = git('rev-parse', '--show-toplevel').trim();
  const changed = git('diff', '--name-only', `${args.base}...${args.head}`).split('\n').filter(Boolean);
  const read = f => { try { return git('show', `${args.head}:${f}`); } catch { return ''; } };
  const version = JSON.parse(read('package.json') || fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tags = git('tag', '-l', 'v*').split('\n').filter(Boolean);

  const r = check({ changed, ignoreText: read('.vscodeignore'), version, tags });
  console.log(`changed files: ${changed.length}, shipped: ${r.shipped.length ? r.shipped.join(', ') : 'none'}`);
  console.log(`package.json version: ${version}, highest tag: ${r.latest || 'none'}`);
  console.log(`${r.ok ? 'ok' : 'FAIL'}: ${r.reason}`);
  if (!r.ok) {
    console.log(`::error file=package.json::${r.reason}`);
    process.exit(1);
  }
}

module.exports = { globToRegExp, parseIgnore, isShipped, parseVersion, compareVersions, highestTag, check };

if (require.main === module) main();
