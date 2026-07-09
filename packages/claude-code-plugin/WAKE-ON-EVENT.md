# Wake-on-terminal-event (Phase 3)

termbridge already exposes structured terminal events (`read_events`, `wait_for_event`,
`read_progress`). This note documents the **wake pattern** for Claude Code / plugin
hosts: block until a session needs attention, then resume the host turn.

## Why

Without wake-on-event, a driving agent must poll on a fixed cadence. With it, the host
can sleep until:

- a permission prompt (`claude-permission`)
- OAuth / login (`oauth-url`, `needs_login`)
- rate limit (`rate_limited`)
- activity phase change (`claude-activity`)
- custom markers (`needs_user_input`, `self_check_request`)

## Pattern (MCP tools)

```ts
// After open_session + send_text for a long task:
const hit = await wait_for_event({
  id,
  kinds: ["claude-permission", "oauth-url", "rate_limited", "needs_user_input"],
  timeoutMs: 600_000,
});
if (!hit.timedOut) {
  // Host "wakes": approve, relay URL, or ask the human.
  for (const ev of hit.events ?? []) {
    if (ev.kind === "claude-permission" && ev.suggestedKeys?.[0]) {
      await send_text({ id, text: ev.suggestedKeys[0], enter: false });
    }
  }
}
```

`wait_for_event` advances an offset cursor so each wake only sees **new** events.

## Plugin usage

1. Install the termbridge MCP (this plugin's `.mcp.json` or `claude mcp add termbridge …`).
2. Prefer `wait_for_event` over tight `read_events` loops for long-running pilots.
3. Pair with `read_progress` digests only when you need phase text for the user —
   not as the sole wake signal.

## Auto-approve vs wake

- **`autoApprove: true`** on `open_session` answers routine permissions in-session
  (WriteLock-aware). Use when the host cannot wake promptly.
- **Wake-on-event** is for host-side handling (human in Discord, OAuth card in the
  browser, custom policy). Prefer one or the other for the same prompt class to
  avoid double-answers.

## Non-goals

- No second protocol beyond MCP tools (D1/D8).
- No detection-evasion timing.
