#!/usr/bin/env node
// Test runner: gives every test file a throwaway $HOME and a port range clear
// of any real editor window, then runs them in sequence.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;

for (const [i, file] of files.entries()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-home-'));
  console.log(`\n── ${file} ──`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: home,
      VSCODE_BRIDGE_TEST_HOME: home,
      // Well clear of 31415 so a headless run never fights a live window.
      VSCODE_BRIDGE_BASE_PORT: String(41415 + i * 10),
    },
  });
  if (r.status !== 0) failed++;
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} test file(s) failed` : `\n${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
