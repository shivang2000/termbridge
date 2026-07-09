# @termbridge/claude-code-plugin

A turnkey [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that
registers the **termbridge MCP server**, giving a `claude` instance the §6 termbridge
tools so it can pilot interactive CLIs (including another Claude Code TUI) over a shared
tmux session.

## What it does

The plugin ships two manifests:

- `.claude-plugin/plugin.json` — the plugin metadata (`name`, `version`, `description`).
- `.mcp.json` — wires up the `termbridge` MCP server. It launches the server with
  `bun packages/mcp-server/src/stdio.ts` and sets `TERMBRIDGE_TMUX_SOCKET=termbridge`.

When loaded, Claude Code gains the termbridge tool surface (session lifecycle, send-keys,
capture-pane, `wait_for_text` / `wait_for_idle`, recognizer-driven prompt answering, etc.).

## Installing

### As a plugin

```sh
claude plugin add ./packages/claude-code-plugin
```

### Or register the MCP server directly

```sh
claude mcp add termbridge \
  --env TERMBRIDGE_TMUX_SOCKET=termbridge \
  -- bun /ABSOLUTE/PATH/TO/termbridge/packages/mcp-server/src/stdio.ts
```

## Important: the MCP server path is repo-relative

The `args` path in `.mcp.json` — `packages/mcp-server/src/stdio.ts` — is **relative to the
termbridge repository root**. It works as-is only when Claude Code is launched from the repo
root. On install, replace it with an **absolute path** to
`packages/mcp-server/src/stdio.ts` (e.g. `/Users/you/dev/termbridge/packages/mcp-server/src/stdio.ts`)
so the server resolves regardless of the working directory.

## Auth / credentials

termbridge runs a logged-in `claude` TUI so usage bills against a **subscription, not the
metered API**. Credentials are **not** bundled with this plugin: they come from the shared
`HOME` volume (`~/.claude/.credentials.json`). Perform the one-time OAuth login once (via the
`oauth-url` recognizer), persist `~/.claude/.credentials.json` on that volume, and every
session that mounts the same `HOME` reuses it.

## Wake-on-terminal-event (Phase 3)

Prefer `wait_for_event` over busy polling so the host turn can sleep until a prompt or
rate-limit appears. See **[WAKE-ON-EVENT.md](./WAKE-ON-EVENT.md)**.
