#!/usr/bin/env bash
# bridgectl — single-command CLI front-end to vscode-bridge.sh.
#
# Why this exists: opening/closing a VS Code bridge terminal from a skill used
# to run as a multi-line block (source the helper, then call a shell function).
# A compound/multi-line Bash command never matches a prefix allow rule, so every
# spawn re-prompted for permission. Routing through this wrapper makes each
# bridge action ONE simple command — e.g.
#
#   bash ~/.vscode-terminal-bridge/bin/bridgectl.sh open <tab> <cwd> <cmd> [icon] [color]
#
# which a single allow rule (`Bash(bash ~/.vscode-terminal-bridge/bin/bridgectl.sh:*)`)
# covers cleanly.
#
# This file is bundled with and written to disk by the sdo.terminal-bridge
# extension itself (see extension.js's writeBundledCli()) — every consuming
# repo calls this one canonical, version-matched copy instead of vendoring its
# own. Edit the copy in this repo's bin/, not the one under
# ~/.vscode-terminal-bridge/.
#
# All subcommands no-op silently outside VS Code / when the bridge is unreachable,
# inheriting that behavior from the sourced helper.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$here/vscode-bridge.sh"

sub="${1:-}"
shift || true

case "$sub" in
  open)   bridge_open   "$@" ;;
  close)  bridge_close  "$@" ;;
  status) bridge_status "$@" ;;
  rename) bridge_rename "$@" ;;
  sweep)  bridge_sweep  "$@" ;;
  ping)   bridge_ping   "$@" && echo "reachable" || { echo "unreachable"; exit 1; } ;;
  *)
    echo "usage: bridgectl.sh {open|close|status|rename|sweep|ping} [args...]" >&2
    exit 2
    ;;
esac
