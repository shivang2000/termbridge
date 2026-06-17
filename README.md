# termbridge

> **Working name — rename freely.** One terminal session that an AI agent (via code/MCP) and a
> human (via a website) attach to at the **same time**.

`termbridge` is a reusable component that lets AI agents — Claude Code, Cursor, Codex, a custom
"Hermes" agent, or anything that speaks the Model Context Protocol (MCP) — **run and interact with a
real terminal/shell session programmatically**, while a human can simultaneously **watch and type into
the same session from a browser**.

**A primary motivating use case:** let a **Hermes agent — or any open-source agent — *use Claude Code***
(and other interactive CLIs) by driving it inside the shared terminal, while a human can still watch and
step in. termbridge is the bridge that makes an interactive CLI agent programmatically operable by another
agent.

It is the missing integration of two halves that already exist separately in our other projects:

- **Human ↔ web terminal** — proven in [`sentry-fixer-bot`](../sentry-fixer-bot) (`alertforge`):
  `xterm.js` in the browser ↔ WebSocket ↔ a server-side PTY running `claude`/`bash`, including driving
  OAuth logins through the browser.
- **Agent ↔ execution environment** — proven in [`paperclip`](../paperclip): adapter + sandbox-provider
  plugins (E2B/Daytona/Cloudflare), a workspace-runtime model, and an MCP server.

The integration that makes both attach to **one** session is built on **tmux as a shared substrate**.

## Status

📋 **Planning / scaffolding.** No runtime code yet. This repo currently contains the detailed plan and
architecture docs. See [`docs/PLAN.md`](docs/PLAN.md).

## How it works (one paragraph)

Each session is a named **tmux** session living inside a pluggable **environment** (local host or a
Docker container; cloud sandboxes later). The **agent** drives it through MCP tools that shell out to
tmux (`send-keys`, `capture-pane`) and never hold the attachment. The **human** opens a browser
`xterm.js` whose WebSocket bridge runs `tmux attach` against the same tmux server. Because both target
the same session, they are co-present and live; tmux gives session persistence and reconnect for free.

## Planned packages

| Package | Role |
|---|---|
| `packages/core` | Framework-agnostic session + environment library (`TerminalEnvironment`, tmux helpers) |
| `packages/mcp-server` | MCP server exposing terminal tools to any agent (built first, after core) |
| `packages/web` | `xterm.js` frontend + WebSocket bridge (`tmux attach` PTY) |
| `packages/claude-code-plugin` | *(later)* turnkey Claude Code plugin + wake-on-terminal-event |

## Docs

- [`docs/PLAN.md`](docs/PLAN.md) — extremely detailed implementation plan
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design, data flow, reuse map
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — cited research behind the design
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — key decisions and rationale (ADRs)

## License

TBD.
