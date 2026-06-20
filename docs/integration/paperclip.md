# Integrating termbridge into paperclip

paperclip's adapter/runtime can pilot `claude` via termbridge as an MCP server (the same stdio contract).

## MCP server config

Add termbridge to paperclip's MCP-servers config (standard MCP `mcpServers` shape — adjust to paperclip's
config location):

```jsonc
{
  "mcpServers": {
    "termbridge": {
      "command": "bun",
      "args": ["/ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts"],
      "env": {
        "TERMBRIDGE_HOME": "/var/lib/termbridge/home",
        "TERMBRIDGE_TMUX_SOCKET": "termbridge",
        "TERMBRIDGE_MAX_SESSIONS": "4"
      }
    }
  }
}
```

After npm publish: `"command": "npx", "args": ["-y", "@termbridge/mcp-server"]`.

## Fleet pattern
- Each paperclip agent opens its own session (`open_session { env: "docker", cwd, cmd: "claude" }`); the
  shared `TERMBRIDGE_HOME` volume means one subscription login serves all of them.
- Respect `TERMBRIDGE_MAX_SESSIONS` and back off on `rate_limited` events (one subscription = real plan
  limits). See the canonical driving loop in `examples/drive-claude.ts`.

> Status: config + flow documented against the stdio server; live-validate in a paperclip runtime before
> relying on it (the §6 tool surface is the stable contract).
