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
  forget) bridge_forget "$@" ;;
  send)   bridge_send   "$@" ;;
  status) bridge_status "$@" ;;
  rename) bridge_rename "$@" ;;
  sweep)  bridge_sweep  "$@" ;;
  list)   bridge_list   "$@" ;;
  hook-status) bridge_hook_status "$@" ;;
  scaffold)    bridge_scaffold    "$@" ;;
  ping)
    if [ "${1:-}" = "--node" ]; then
      bridge_ping_node "$2" && echo "reachable" || { echo "unreachable"; exit 1; }
    else
      bridge_ping "$@" && echo "reachable" || { echo "unreachable"; exit 1; }
    fi
    ;;
  *)
    echo "usage: bridgectl.sh {open|close|forget|send|status|rename|sweep|list|ping|hook-status|scaffold} [args...]" >&2
    echo "       bridgectl.sh open <name> <cwd> [cmd] [icon] [color] [--node=<name>] [--ref=<ref>] [--cmd-file=<path>]" >&2
    echo "       bridgectl.sh send <name> <text>|--text-file=<path> [--no-submit] [--force] [--mode=auto|paste|literal|join]" >&2
    echo "         (send refuses when the target sits at an interactive prompt — injected text would answer it. --force overrides.)" >&2
    echo "         (exit 0 means delivered to the terminal, not read: confirm receipt via a status change in \`list\`.)" >&2
    echo "       bridgectl.sh close <name>    # disposes the terminal AND removes its tracked row; prints outcome JSON" >&2
    echo "       bridgectl.sh forget <name>   # removes the tracked row only, never touches a process" >&2
    echo "       bridgectl.sh hook-status <status> [--name=<name>]   # reads Cline's stdin payload or Claude's env" >&2
    echo "       bridgectl.sh scaffold --backend {cline|claude} [--dir=<repo>] [--force]" >&2
    echo "       bridgectl.sh ping --node <name>" >&2
    exit 2
    ;;
esac
