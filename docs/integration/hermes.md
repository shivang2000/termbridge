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
The agent calls the 13 §6 tools (see [README](./README.md)). The canonical loop — open → send task →
`wait_for_event` for `claude-permission` → answer with `suggestedKeys` → read result — is in
[`examples/drive-claude.ts`](../../examples/drive-claude.ts). Handle `needs_login`, `rate_limited`,
`human_took_over`.

> Status: documented against the stdio contract; live-validate in the Hermes runtime. Any MCP client that
> can spawn a stdio server + call tools works the same way.

## Autonomous engineering loop + live progress (M7)

Beyond one-shot driving, the `engineer-loop` skill (vendored in the repo at
[`skills/engineer-loop/SKILL.md`](../../skills/engineer-loop/SKILL.md) — copy it to
`~/.hermes/skills/engineer-loop/SKILL.md`) lets Hermes
take a coding task from the user, drive `claude` to completion through the tools, and stream ~25s progress
digests back (e.g. to a Discord thread). It self-verifies with the repo's tests and **asks for
verification steps if the user gives none**. It uses `read_progress` (phase + delta + idle) for the
digests and `wait_for_idle` for authoritative round-complete, gating "done" on a `TB_LOOP_DONE: PASS`
marker claude prints after its tests pass.

**Lock the gateway to containers.** A chat-triggered loop runs `open_session`, which defaults to the
host. Pin the termbridge MCP server to docker so it can never execute on the host:

```yaml
mcp_servers:
  termbridge:
    command: bun
    args: [/ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts]
    env:
      TERMBRIDGE_HOME: /Users/you/.termbridge/home
      TERMBRIDGE_TMUX_SOCKET: termbridge
      TERMBRIDGE_ALLOWED_ENVS: docker      # untrusted caller → docker-only (rejects env:local)
      TERMBRIDGE_MAX_SESSIONS: "3"
```

The reusable, agent-agnostic version of the same loop is `@termbridge/orchestrator` (`runEngineerLoop`) —
drive it from any runtime over a `ToolCall` (stdio MCP, the server's `/api/tool`, or in-process specs).
See `scripts/smoke-engineer-loop.ts` for a runnable end-to-end example.
