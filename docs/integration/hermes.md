# Integrating termbridge into Hermes (or any MCP agent)

Hermes (or any open-source MCP-capable agent) pilots `claude` through termbridge's stdio MCP server.

## MCP server config

Standard MCP `mcpServers` stdio entry (place it wherever the agent loads MCP servers):

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

## Driving
The agent calls the 12 §6 tools (see [README](./README.md)). The canonical loop — open → send task →
`wait_for_event` for `claude-permission` → answer with `suggestedKeys` → read result — is in
[`examples/drive-claude.ts`](../../examples/drive-claude.ts). Handle `needs_login`, `rate_limited`,
`human_took_over`.

> Status: documented against the stdio contract; live-validate in the Hermes runtime. Any MCP client that
> can spawn a stdio server + call tools works the same way.
