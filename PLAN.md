# PLAN — #83

1. `bridge.js`
   - `VERSION` from `package.json`; reported as `version` on `/ping` and in the `bridges/<id>.json` entry.
   - `repairDiscovery()` inside `startBridge`: once listening, rewrite each folder's `.vscode-bridge-port`,
     `~/.vscode-terminal-bridge/port` and this bridge's registry entry when missing or holding another port.
     One log line per repair (listing what it rewrote); nothing on a healthy tick.
     Runs on a timer only when `host.repairIntervalMs` is set (headless sets it); cleared on dispose.
   - `removePortFiles()` unlinks a folder port file / the fallback only when it holds `activePort`.
2. `headless.js`: `repairIntervalMs` from `VSCODE_BRIDGE_REPAIR_MS`, default 30 s.
3. `extension.js`: `startViewer` compares `headless.version` with the extension's own version; on skew it
   logs once and the panel description shows both (`headless · 31415 · v0.33.2 ≠ window v0.33.1`).
   A headless bridge with no `version` (≤0.33.1) reads as `v?` — also skew.
4. Tests:
   - `test/headless-repair.test.js` (tmux): delete/overwrite folder port file, fallback, registry entry;
     all restored within one interval; one log line per repair, none on healthy ticks; `/ping` has `version`.
   - `test/port-files-own.test.js` (harness): dispose leaves a port file holding another port, removes one
     holding its own; fallback holding another port survives.
   - `test/coexist.test.js`: skew shows both versions in the description; matching version doesn't.
5. README: `version` fields, repair behaviour, Upgrading section (link house.health#6966). CLAUDE.md design note.
6. Bump 0.33.1 → 0.33.2 (rebase on #82 if it lands first, take next patch). `npm test`, PR, wait green.
