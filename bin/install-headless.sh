#!/usr/bin/env bash
# Install the headless bridge (#77) as a systemd --user service, so a host runs
# a bridge all the time with no VS Code window open.
#
#   bash bin/install-headless.sh [--folder=<path>]... [--agent-id=<id>] [--socket=<name>]
#   bash bin/install-headless.sh --print-unit [...]   # render the unit, install nothing
#
# Copies the runtime files to ~/.vscode-terminal-bridge/headless/app (so the
# service never depends on where this checkout lives), writes
# ~/.config/systemd/user/vscode-terminal-bridge.service, enables and starts it,
# and turns on linger so it starts at boot without anyone logging in.
# Re-running it upgrades in place and restarts the bridge; tmux sessions
# survive the restart (KillMode=process in the unit).
set -euo pipefail
# bash 5.2 makes `&` in a ${x//pat/rep} replacement mean "the match".
shopt -u patsub_replacement 2>/dev/null || true

src="$(cd "$(dirname "$0")/.." && pwd)"
state="$HOME/.vscode-terminal-bridge/headless"
app="$state/app"
unit_name="vscode-terminal-bridge.service"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

die() { echo "install-headless: $*" >&2; exit 1; }

print_only=0
args=()
for arg in "$@"; do
  case "$arg" in
    --print-unit)          print_only=1 ;;
    --folder=*)            args+=(--folder "$(cd "${arg#--folder=}" 2>/dev/null && pwd || echo "${arg#--folder=}")") ;;
    --agent-id=*)          args+=(--agent-id "${arg#--agent-id=}") ;;
    --socket=*)            args+=(--socket "${arg#--socket=}") ;;
    --pipeline-state-dir=*) args+=(--pipeline-state-dir "${arg#--pipeline-state-dir=}") ;;
    *) die "unknown argument: $arg" ;;
  esac
done

node_bin="$(command -v node)" || die "node is not on PATH"

# systemd splits ExecStart on whitespace and honours double quotes.
exec_args=""
for a in "${args[@]+"${args[@]}"}"; do
  case "$a" in
    *'"'*|*'\'*) die "argument contains a quote or backslash: $a" ;;
  esac
  exec_args+=" \"$a\""
done

render_unit() {
  local tmpl
  tmpl="$(cat "$src/systemd/$unit_name")"
  tmpl="${tmpl//@NODE@/$node_bin}"
  tmpl="${tmpl//@APP@/$app}"
  tmpl="${tmpl//@ARGS@/${exec_args# }}"
  tmpl="${tmpl//@PATH@/$PATH}"
  printf '%s\n' "$tmpl"
}

if [ "$print_only" = 1 ]; then
  render_unit
  exit 0
fi

command -v tmux >/dev/null || die "tmux is not installed (the headless bridge's terminals are tmux sessions)"
command -v systemctl >/dev/null || die "systemctl not found; run headless.js under your own supervisor instead"

mkdir -p "$app/bin" "$unit_dir"
cp "$src/bridge.js" "$src/headless.js" "$src/package.json" "$app/"
for f in vscode-bridge.sh bridgectl.sh bridge-tail.sh bridge-worker.js; do
  cp "$src/bin/$f" "$app/bin/$f"
  chmod 755 "$app/bin/$f"
done

render_unit > "$unit_dir/$unit_name"
echo "install-headless: wrote $unit_dir/$unit_name"

systemctl --user daemon-reload
systemctl --user enable "$unit_name" >/dev/null
systemctl --user restart "$unit_name"

# cron (host-sync) runs this with no USER in the environment; set -u would stop
# the script here, after the restart, so host-sync never marked it done and
# restarted the bridge every five minutes.
user="${USER:-$(id -un)}"
if loginctl enable-linger "$user" 2>/dev/null; then
  echo "install-headless: linger on for $user (starts at boot, no login needed)"
else
  echo "install-headless: could not enable linger; run: sudo loginctl enable-linger $user" >&2
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -s "$HOME/.vscode-terminal-bridge/port" ]; then
    port="$(cat "$HOME/.vscode-terminal-bridge/port")"
    if curl -fsS -m 2 "http://127.0.0.1:$port/ping" 2>/dev/null | grep -q '"backend":"tmux"'; then
      echo "install-headless: headless bridge up on 127.0.0.1:$port"
      exit 0
    fi
  fi
  sleep 1
done
die "the service did not come up; see: journalctl --user -u $unit_name"
