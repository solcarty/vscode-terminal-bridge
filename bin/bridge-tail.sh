#!/usr/bin/env bash
# bridge-tail.sh <node> <jobId>
#
# Polls a worker node (bin/worker.js) for a job started via /open-terminal's
# node= param, prints new log output as it arrives, and drives this *local*
# terminal tab's status icon via the existing bridge_status helper — so a job
# actually running on a remote machine still looks and feels like a normal
# local terminal tab in VS Code.
#
# Bundled by extension.js's writeBundledCli() alongside bridgectl.sh /
# vscode-bridge.sh; edit the copy in this repo's bin/, not the one under
# ~/.vscode-terminal-bridge/.
set -euo pipefail

node_name="${1:?usage: bridge-tail.sh <node> <jobId>}"
job_id="${2:?usage: bridge-tail.sh <node> <jobId>}"

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$here/vscode-bridge.sh"

tab_name="${CLAUDE_TAB_NAME:-$job_id}"
nodes_file="$HOME/.vscode-terminal-bridge/nodes.json"

# Resolve host/port/token for $node_name. Uses `node` (already required to
# run the worker this talks to) instead of jq, so there's no extra dependency.
registry_line=$(node -e '
  const fs = require("fs");
  const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const cfg = reg[process.argv[2]];
  if (!cfg) process.exit(1);
  console.log(`${cfg.host} ${cfg.port} ${cfg.token}`);
' "$nodes_file" "$node_name") || {
  echo "bridge-tail: unknown node \"$node_name\" — check $nodes_file" >&2
  bridge_status "$tab_name" error
  exit 1
}
read -r host port token <<< "$registry_line"

offset=0
bridge_status "$tab_name" working

while true; do
  resp=$(curl -fsS -m 5 --get \
    --data-urlencode "id=$job_id" --data-urlencode "offset=$offset" \
    -H "Authorization: Bearer $token" \
    "http://$host:$port/job-status" 2>/dev/null) || {
    # Transient unreachable (worker rebooting, network blip) is not a job
    # failure — hold the last known status and retry instead of flipping to
    # error on a false signal.
    sleep 3
    continue
  }

  # First line is "META <done> <exitCode> <nextOffset> <noteUpdatedAt>";
  # everything after is the raw log chunk to print verbatim.
  out=$(node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const j = JSON.parse(raw);
      process.stdout.write(`META ${j.done ? 1 : 0} ${j.exitCode ?? ""} ${j.nextOffset} ${j.noteUpdatedAt ?? "-"}\n`);
      if (j.logChunk) process.stdout.write(j.logChunk);
    });
  ' <<< "$resp")

  meta_line=$(printf '%s\n' "$out" | head -n1)
  read -r _ done_flag exit_code next_offset note_updated <<< "$meta_line"
  printf '%s\n' "$out" | tail -n +2

  offset="$next_offset"

  # Relay a published note into the LOCAL bridge. A remote job has no shared
  # filesystem with the orchestrating session and can't reach its 127.0.0.1
  # bridge, so this poll is the only rail a note can ride home. Only on change,
  # so a static note isn't rewritten every three seconds.
  if [ -n "${note_updated:-}" ] && [ "$note_updated" != "-" ] && [ "$note_updated" != "${last_note_updated:-}" ]; then
    note_tmp=$(mktemp)
    if node -e '
      let raw = "";
      process.stdin.on("data", c => raw += c);
      process.stdin.on("end", () => {
        const j = JSON.parse(raw);
        if (j.note) process.stdout.write(j.note);
      });
    ' <<< "$resp" > "$note_tmp" && [ -s "$note_tmp" ]; then
      bridge_note set --text-file="$note_tmp" --name="$tab_name"
      last_note_updated="$note_updated"
    fi
    rm -f "$note_tmp"
  fi

  if [ "$done_flag" = "1" ]; then
    if [ "$exit_code" = "0" ]; then
      bridge_status "$tab_name" task-done
      exit 0
    else
      echo "[bridge-tail] job exited $exit_code" >&2
      bridge_status "$tab_name" error
      exit 1
    fi
  fi

  sleep 3
done
