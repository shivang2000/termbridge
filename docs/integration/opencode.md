# Integrating termbridge into opencode

opencode supports MCP servers, so it pilots `claude` through termbridge's stdio server like any other
MCP client.

## MCP server config

In opencode's config (`opencode.json` / the MCP section), add a local (stdio) MCP server:

```jsonc
{
  "mcp": {
    "termbridge": {
      "type": "local",
      "command": ["bun", "/ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts"],
      "environment": {
        "TERMBRIDGE_HOME": "/var/lib/termbridge/home",
        "TERMBRIDGE_TMUX_SOCKET": "termbridge",
        "TERMBRIDGE_MAX_SESSIONS": "4"
      },
      "enabled": true
    }
  }
}
```

After npm publish: `"command": ["npx", "-y", "@termbridge/mcp-server"]`.

## Driving
Same 12-tool surface + canonical loop as the other agents — see [README](./README.md) and
[`examples/drive-claude.ts`](../../examples/drive-claude.ts).

> Status: config shape per opencode's MCP docs; field names may differ by version — adjust to your
> opencode release. The stdio command + env + §6 tools are the stable part.
