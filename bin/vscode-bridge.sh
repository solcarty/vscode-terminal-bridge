#!/usr/bin/env bash
# VS Code Terminal Bridge helpers for Paloma skills.
#
# All functions silently no-op when the bridge isn't reachable — either VS Code
# isn't running, the extension isn't installed, or the current shell can't see
# a .vscode-bridge-port file. Works from interactive VS Code terminals, Zed,
# JetBrains, iTerm, AND agent-spawned shells (which don't set $TERM_PROGRAM).
#
# This file is bundled with and written to disk by the sdo.terminal-bridge
# extension itself (see extension.js's writeBundledCli()) so every consuming
# repo calls one canonical, version-matched copy instead of vendoring its own.
# Edit the copy in this repo's bin/, not the one under ~/.vscode-terminal-bridge/.
#
# Designed for sdo.terminal-bridge v0.7.0+ which handles focus preservation
# and CLAUDE_TAB_NAME injection upstream, and accepts quiet=1 on
# /rename-terminal. Older bridges still work; the helpers just lose those
# niceties.
#
# v0.12.x adds two robustness wins the helpers lean on: /close-terminal now
# falls back to killing the persisted shell PID when the in-memory registry
# has desynced (reload / multi-window / host restart), so bridge_close lands
# even on a zombie tab; and /sweep disposes terminals whose cwd no longer maps
# to a live `git worktree list` entry (exposed here as bridge_sweep, used after
# worktree removal to clear orphaned tabs). Both no-op on older bridges.
#
# Usage (from a skill):
#   . ~/.vscode-terminal-bridge/bin/vscode-bridge.sh
#   bridge_open  "$TAB_NAME" "$WORKTREE_DIR" "$CMD"
#   bridge_status "$TAB_NAME" working
#   bridge_status "$TAB_NAME" pr-open
#   bridge_close "$TAB_NAME"

# ---- internals ----------------------------------------------------------

# Walk up from $1 (default $PWD) looking for .vscode-bridge-port. Falls back
# to 31415 (v0.5.0 hardcoded port) so older bridge installs keep working.
#
# Uses POSIX parameter expansion (${dir%/*}) instead of `dirname`, and the
# shell built-in `read` instead of `cat`, so this works even when the
# calling shell has a stripped PATH missing /bin or /usr/bin (agent-spawned
# subshells in Claude Code's Bash tool sometimes do).
_bridge_port() {
  # Prefer the port pinned by the window that spawned this terminal (set by
  # the extension on every bridge_open). This is the only reliable signal
  # when the same multi-root workspace is open in more than one VS Code
  # window — each window overwrites the same shared .vscode-bridge-port file
  # in the folders it sees, so that file can point at a *different* window's
  # server than the one that actually owns this shell.
  if [ -n "${VSCODE_BRIDGE_PORT:-}" ]; then
    echo "$VSCODE_BRIDGE_PORT"
    return
  fi
  local dir="${1:-$PWD}"
  # If $1 is relative, resolve it via cd; on failure fall back to PWD rather
  # than aborting, so the helper still works in a stripped-PATH shell.
  if [ "${dir#/}" = "$dir" ]; then
    dir=$(cd "$dir" 2>/dev/null && pwd) || dir="$PWD"
  fi
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.vscode-bridge-port" ]; then
      # Read the port via shell built-in to avoid depending on /bin/cat.
      local port
      IFS= read -r port < "$dir/.vscode-bridge-port"
      echo "$port"
      return
    fi
    # POSIX parent-dir without calling `dirname`.
    case "$dir" in
      */*) dir="${dir%/*}" ;;
      *)   dir="" ;;
    esac
  done
  # User-level fallback written by the extension on every activation (v0.16.0+),
  # for callers whose $PWD is outside any workspace folder. Consulted only after
  # the walk-up fails, so a window-local port file still wins where one exists —
  # this file carries the same multi-window ambiguity as the shared workspace
  # one, and is a better guess than the hardcoded default below, not a
  # replacement for VSCODE_BRIDGE_PORT.
  if [ -f "$HOME/.vscode-terminal-bridge/port" ]; then
    local fallback_port
    IFS= read -r fallback_port < "$HOME/.vscode-terminal-bridge/port"
    if [ -n "$fallback_port" ]; then
      echo "$fallback_port"
      return
    fi
  fi
  echo 31415
}

_bridge_active() {
  # Interactive VS Code terminal: $TERM_PROGRAM tells us directly.
  [ "${TERM_PROGRAM:-}" = "vscode" ] && return 0
  # A bridge-spawned terminal (or a subshell descended from one) always has
  # this pinned by the extension — see the VSCODE_BRIDGE_PORT note above.
  [ -n "${VSCODE_BRIDGE_PORT:-}" ] && return 0
  # Agent-spawned shells (Claude Code hooks, sub-agents) don't inherit
  # $TERM_PROGRAM, but the bridge writes .vscode-bridge-port into each
  # workspace folder while it's running. If we can find one walking up
  # from $PWD, the bridge is reachable.
  local dir="$PWD"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    [ -f "$dir/.vscode-bridge-port" ] && return 0
    case "$dir" in
      */*) dir="${dir%/*}" ;;
      *)   dir="" ;;
    esac
  done
  # Last resort: the user-level port file the extension writes on every
  # activation (v0.16.0+). The walk-up above only succeeds when $PWD happens to
  # sit under a workspace folder — an agent shell that cd'd to /tmp, a scratch
  # dir, or anywhere else outside the tree would otherwise conclude "no bridge"
  # while the server is running perfectly well. cwd is not evidence about
  # whether a local HTTP server exists.
  [ -f "$HOME/.vscode-terminal-bridge/port" ] && return 0
  return 1
}

# ---- public API ---------------------------------------------------------

# All requests use `curl --get --data-urlencode` so we don't depend on
# `python3` for URL encoding — agent-spawned subshells sometimes have a
# stripped PATH and python3 isn't reachable.

# bridge_ping [port] — returns 0 if bridge is reachable, 1 otherwise.
bridge_ping() {
  _bridge_active || return 1
  local port="${1:-$(_bridge_port)}"
  curl -fsS -m 1 "http://127.0.0.1:${port}/ping" >/dev/null 2>&1
}

# bridge_ping_node <node-name> — checks a worker registered in
# ~/.vscode-terminal-bridge/nodes.json directly (bypasses the local bridge
# entirely). Returns 0 if reachable, 1 otherwise. Use this once after adding
# a node to nodes.json, before trusting it with real jobs.
bridge_ping_node() {
  local node_name="$1"
  local nodes_file="$HOME/.vscode-terminal-bridge/nodes.json"
  local line
  line=$(node -e '
    const fs = require("fs");
    const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const cfg = reg[process.argv[2]];
    if (!cfg) process.exit(1);
    console.log(`${cfg.host} ${cfg.port} ${cfg.token}`);
  ' "$nodes_file" "$node_name") || return 1
  local host port token
  read -r host port token <<< "$line"
  curl -fsS -m 2 -H "Authorization: Bearer $token" "http://$host:$port/ping" >/dev/null 2>&1
}

# bridge_open <name> <cwd> [cmd] [icon] [color] [--node=<name>] [--ref=<ref>] [--cmd-file=<path>]
#
# Bridge v0.7.0+ exports CLAUDE_TAB_NAME automatically and preserves focus by
# default on open. No prefix or focus-handling needed here.
#
# --node=<name> offloads <cmd> to a worker (bin/worker.js) registered in
# ~/.vscode-terminal-bridge/nodes.json instead of running it in this window.
# The local tab becomes a live proxy onto the remote job — see bridge-tail.sh.
#
# --cmd-file=<path> — for long or quote-heavy commands (e.g. a multi-hundred
# character agent kickoff prompt) that don't reliably survive shell-quoting +
# URL-encoding + re-parsing by the terminal's shell as one inline string.
# Write the command to <path> and pass this instead of a positional cmd; the
# bridge runs `bash <path>` in the terminal instead.
bridge_open() {
  _bridge_active || return 0
  local name="$1" cwd="$2"; shift 2
  local cmd="" icon="" color="" node="" ref="" cmdFile=""
  local positional=()
  for arg in "$@"; do
    case "$arg" in
      --node=*)     node="${arg#--node=}" ;;
      --ref=*)      ref="${arg#--ref=}"   ;;
      --cmd-file=*) cmdFile="${arg#--cmd-file=}" ;;
      *)            positional+=("$arg")  ;;
    esac
  done
  cmd="${positional[0]:-}"; icon="${positional[1]:-}"; color="${positional[2]:-}"

  local port
  port=$(_bridge_port "$cwd")
  set -- --data-urlencode "name=$name" --data-urlencode "cwd=$cwd"
  [ -n "$cmd" ]     && set -- "$@" --data-urlencode "cmd=$cmd"
  [ -n "$cmdFile" ] && set -- "$@" --data-urlencode "cmdFile=$cmdFile"
  [ -n "$icon" ]  && set -- "$@" --data-urlencode "icon=$icon"
  [ -n "$color" ] && set -- "$@" --data-urlencode "color=$color"
  [ -n "$node" ]  && set -- "$@" --data-urlencode "node=$node"
  [ -n "$ref" ]   && set -- "$@" --data-urlencode "ref=$ref"
  local response
  if ! response=$(curl -fsS -m 2 --get "$@" "http://127.0.0.1:${port}/open-terminal" 2>&1); then
    echo "bridge_open: failed to reach bridge on port $port: $response" >&2
    return 1
  fi
  case "$response" in
    *'"ok":true'*) : ;;
    *) echo "bridge_open: bridge reported failure: $response" >&2; return 1 ;;
  esac
}

# bridge_list — query all bridge-tracked terminals as JSON:
# {ok, terminals:[{name, cwd, label, status, node, jobId, pid, live}]}.
# Bridge v0.15.0+; older bridges 404 and this prints nothing / returns 1.
# bridge_list — unlike the mutating commands, this is a *query*, so it must not
# no-op silently. An empty stdout with exit 0 is indistinguishable from "the
# bridge is up and tracking zero terminals", which makes a dead or unregistered
# terminal look identical to a healthy empty list. Callers that poll this to
# decide whether an agent terminal is still alive read that silence as fact.
# So: emit a structured error and exit non-zero when we can't reach the bridge.
# The mutating commands (open/close/status/rename/sweep) keep the silent no-op —
# hooks call those outside VS Code and shouldn't fail under `set -e`.
bridge_list() {
  if ! _bridge_active; then
    echo '{"ok":false,"reason":"bridge-unreachable"}'
    return 1
  fi
  local port
  port=$(_bridge_port)
  local out
  if ! out=$(curl -fsS -m 2 "http://127.0.0.1:${port}/list" 2>/dev/null); then
    echo '{"ok":false,"reason":"bridge-unreachable"}'
    return 1
  fi
  echo "$out"
}

# bridge_close <name>
bridge_close() {
  _bridge_active || return 0
  local name="$1"
  local port
  port=$(_bridge_port)
  curl -fsS -m 1 --get --data-urlencode "name=$name" \
    "http://127.0.0.1:${port}/close-terminal" >/dev/null 2>&1 || true
}

# bridge_sweep — dispose every tracked terminal whose cwd no longer maps to a
# live `git worktree list` entry, returning {ok, closed:[names]}. Bridge
# v0.12.0+; older bridges 404 and this no-ops. Safe (and idempotent) to fire
# after `git worktree remove` to clear tabs orphaned in a now-deleted cwd —
# the bridge also runs this itself a few seconds after activation.
bridge_sweep() {
  _bridge_active || return 0
  local port
  port=$(_bridge_port)
  curl -fsS -m 2 "http://127.0.0.1:${port}/sweep" >/dev/null 2>&1 || true
}

# bridge_rename <name> <label> [icon] [color]
# Low-level rename. Prefer bridge_status for standard lifecycle states.
bridge_rename() {
  _bridge_active || return 0
  local name="$1" label="$2" icon="${3:-}" color="${4:-}"
  local port
  port=$(_bridge_port)
  set -- --data-urlencode "name=$name" --data-urlencode "label=$label"
  [ -n "$icon" ]  && set -- "$@" --data-urlencode "icon=$icon"
  [ -n "$color" ] && set -- "$@" --data-urlencode "color=$color"
  curl -fsS -m 1 --get "$@" "http://127.0.0.1:${port}/rename-terminal" >/dev/null 2>&1 || true
}

# bridge_status <name> <state>
# Hands a canonical lifecycle state to the bridge's status= param (v0.8.0+).
# The bridge owns the state — codicon + color mapping, prefixes the label
# with an inline $(codicon) glyph, and sets the matching color. The identity
# icon set at bridge_open (e.g. "hubot") is never touched.
#
# Canonical states (mapping lives in bridge extension's STATUS_MAP):
#   working       — PreToolUse hook
#   needs-input   — Notification hook
#   idle          — Stop hook
#   pr-open       — skill-driven, post gh pr create
#   merged        — skill-driven, merge-sweep finds merged PR
#   none          — strip prefix and reset color (manual reset)
bridge_status() {
  _bridge_active || return 0
  if [ "$#" -lt 2 ]; then
    echo "usage: bridgectl.sh status <name> <state>" >&2
    return 2
  fi
  local name="$1" state="$2"
  local port
  port=$(_bridge_port)
  curl -fsS -m 1 --get \
    --data-urlencode "name=$name" \
    --data-urlencode "status=$state" \
    "http://127.0.0.1:${port}/rename-terminal" >/dev/null 2>&1 || true
}
