# PLAN — #82

## Root cause (from captured payloads, Claude Code 2.1.302, dev-1)

The #51 downgrade still fires. The real idle payload is
`{"message":"Claude is waiting for your input","notification_type":"idle_prompt",...}`, the `sed`
extracts the message, and the `case` matches, so the state becomes `idle`. The #4589 idle-note
guard then promotes it back to `needs-input`.

After every turn, Claude Code runs a prompt-suggestion fork. That fork fires `SubagentStop` with
`agent_type: ""` about 1 s *after* the main `Stop` (captured: Stop 01:05:41.1, SubagentStop
01:05:42.5, with no SubagentStart). It is wired as `SubagentStop → hook-status working`, so it writes
`working` and `_bridge_turn_track` arms a fresh turn-start mark after the Stop's handoff cleared it.
60 s later the nudge is downgraded to `idle`, the guard sees a turn with no note newer than its
start, and it writes `needs-input`. Live on dev-1, tab 6962: lastOutputAt 01:00:11 (Stop), mark
01:00:12, needs-input 01:01:11.

The same out-of-order `SubagentStop` also overwrites `permission` with `working` when a background
subagent ends while a permission prompt is up (captured: PermissionRequest 01:04:54.4, SubagentStop
01:04:55.4).

## Fix (`bin/vscode-bridge.sh`, `bridge_hook_status`)

1. **SubagentStop never starts a turn.** When the payload's `hook_event_name` is `SubagentStop`,
   write `working` only if the last tracked state is `working` or `subagent`. Otherwise, or when
   unknown, it's a no-op: no status write and no turn-mark change. No settings.json change is needed.
2. **Prefer `notification_type`.** `idle_prompt` → `idle`. Any other type (`permission_prompt`, an
   unknown one) stays `needs-input`, whatever the message says. With no type, fall back to the
   existing message match. A permission prompt is never demoted.
3. Keep the guard as is. A Stop with no handoff must still re-assert `needs-input` on the nudge.

## Tests

- `test/fixtures/claude-hooks/*.json`: the captured payloads, sanitized.
- `test/hook-status-notification.test.js`: real idle → idle, real permission → needs-input,
  `notification_type` beats the message both ways, and the existing cases still pass.
- A sequence test: working → Stop (real) → post-Stop SubagentStop (real) → idle nudge (real) gives
  `idle`. Fails before the fix. Also: SubagentStop during `permission` leaves it alone, SubagentStop
  after `subagent` still writes `working`, and a Stop with no handoff still ends at `needs-input`.

## Ship

Bump 0.33.1 → 0.33.2. Update the CLAUDE.md reasoning and the README if it documents the hook. Run
`npm test`, push, and `gh pr create` "… (#82)" with `Closes #82`. The PR body gives the root cause,
the payload, and install steps: `install-headless.sh` on the dev hosts, the VSIX on the laptop. Do
not install on any host.
