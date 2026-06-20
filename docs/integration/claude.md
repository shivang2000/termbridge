# Integrating termbridge into Claude Code

Claude Code is itself an MCP client, so it can pilot *another* `claude` session through termbridge.

## Add the server

```bash
claude mcp add termbridge \
  --env TERMBRIDGE_HOME=$HOME/.termbridge/home \
  --env TERMBRIDGE_TMUX_SOCKET=termbridge \
  -- bun /ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts
# after npm publish:  -- npx -y @termbridge/mcp-server
```

`claude mcp list` should show `termbridge` with the 12 tools.

## Worked example (drive a Dockerized claude to edit a repo)

From the agent (tool calls):

```jsonc
open_session   { "env": "docker", "cwd": "/abs/repo", "cmd": "claude" }   // → { id }
// claude shows a trust-folder gate:
read_events    { "id": "<id>" }                 // → claude-permission kind "trust", suggestedKeys ["1"]
send_text      { "id": "<id>", "text": "1", "enter": false }
send_text      { "id": "<id>", "text": "Edit hello.txt: replace World with termbridge.", "enter": true }
wait_for_event { "id": "<id>", "kinds": ["claude-permission"], "timeoutMs": 60000 }
send_text      { "id": "<id>", "text": "1", "enter": false }   // approve the edit
read_screen    { "id": "<id>" }                                // confirm the change
close_session  { "id": "<id>" }
```

This is the exact flow verified live in `scripts/accept-final.ts` (host runs the unified server; the agent
calls the same tools over HTTP) and is the reference for any consumer.

## Notes
- The stdio server gets its own in-process `SessionManager`. To also **watch** the session in a browser
  while the agent drives it, run the unified server (`packages/server`) instead and have the agent call its
  `POST /api/tool/:name` — one shared registry. See `packages/server`.
- Cap concurrency with `TERMBRIDGE_MAX_SESSIONS`. Handle `rate_limited` / `needs_login` events.
