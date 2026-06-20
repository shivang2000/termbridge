# M3 — MCP server (milestone plan)

Authority: spec §5.2, §6, §9; decision D3 (MCP-first). Master plan: M1–M6.

## Goal

`packages/mcp-server` (`@termbridge/mcp-server`) — exposes the full §6 tool surface over
`@termbridge/core`'s `SessionManager`, via the MCP **stdio** transport, so any MCP-capable agent
(Claude Code, etc.) can pilot sessions. Mirrors paperclip's `makeTool` + stdio layout
(`@modelcontextprotocol/sdk`, zod). Framework-agnostic core stays import-clean (no MCP imports in core).

## Tool surface (§6) → core

| MCP tool | core call | returns |
|---|---|---|
| `open_session` {name?,env?,cwd?,repo?,branch?,cmd?,cols?,rows?} | `manager.open(opts)` | `{id,name,env}` |
| `list_sessions` {} | `manager.list()` | `{sessions:[{id,name,env,state}]}` |
| `send_text` {id,text,enter?=true} | `session.sendText` | `{ok}` or `{ok:false,error:"human_driving"}` |
| `send_control` {id,key} | `session.sendControl` | `{ok}` / human_driving |
| `read_screen` {id,scrollback?} | `session.readScreen` | `{screen}` |
| `read_new_output` {id,sinceOffset?} | `session.readNewOutput` | `{data,nextOffset}` |
| `wait_for_idle` {id,quietMs?,timeoutMs?} | `session.waitForIdle` | `{idle,waitedMs}` |
| `wait_for_text` {id,pattern,timeoutMs?} | `session.waitForText` | `{matched,screen}` |
| `read_events` {id,sinceOffset?} | `session.readEvents` | `{events,nextOffset}` |
| `resize` {id,cols,rows} | `session.resize` | `{ok}` |
| `close_session` {id} | `manager.close(id)` | `{ok}` |

- Unknown `id` → tool returns an error result (`isError`), never crashes the server.
- `send_text`/`send_control` while a human is driving → `{ok:false,error:"human_driving"}` as normal data
  (NOT an error result, NOT a throw) — spec §9.

## Core change (minimal, additive)

Add `readonly id` to `Session` (`SessionDeps.id?`, defaults to `name`); `SessionManager.open()` passes the
generated id. Lets `open_session` return the id that later tools pass to `manager.get(id)`. No test
breakage (optional with fallback).

## Files

- `packages/mcp-server/package.json` — `@modelcontextprotocol/sdk ^1.29`, `zod`, `@termbridge/core`
  workspace:*; `bin` → `src/stdio.ts`.
- `src/format.ts` — `formatTextResponse(data)` / `formatErrorResponse(err)` → MCP `{content:[{type:"text",
  text}]}` (+`isError`).
- `src/tools.ts` — `makeTool(name,description,zodShape,execute)` + `createToolDefinitions(manager)` for the
  11 tools.
- `src/server.ts` — builds an `McpServer`, registers the tools over one `SessionManager`.
- `src/stdio.ts` — `#!/usr/bin/env bun` entry; `runServer()` on `StdioServerTransport`.
- `src/index.ts` — barrel (`createServer`, `createToolDefinitions`).
- `scripts/smoke-m3.ts` — connects an MCP **client** (SDK `Client` + `StdioClientTransport`) to the server
  over stdio, drives open → send_text → wait_for_idle → read_screen, asserts the marker, closes. Env via
  `TERMBRIDGE_SMOKE_ENV` (local|docker).

## Verification

- Unit gate (host-safe, mocked): `turbo run test lint typecheck` green — `tools.test.ts` drives
  `createToolDefinitions` against a `SessionManager` wired with a **mock exec** (no real tmux/docker),
  asserting each tool's mapping + the `human_driving` data result + unknown-id error.
- **M3 smoke — Local:** run `scripts/smoke-m3.ts` (env=local) **inside the `termbridge:dev` container** —
  MCP client ⇄ stdio server ⇄ core ⇄ tmux-in-container. Asserts the marker over MCP.
- **M3 smoke — Docker:** run `scripts/smoke-m3.ts` (env=docker) **on the host** — server spawns a
  per-session container; host tmux untouched.
- Manual: `claude mcp add termbridge -- bun <repo>/packages/mcp-server/src/stdio.ts` then pilot from
  Claude Code (documented, not automated).

## Ship

Commit `feat(core): Session.id`, `feat(mcp-server): §6 tool surface over core (stdio)`,
`chore(test): M3 MCP smoke`; push; **pause before M4.**

## Notes / risks
- SDK API: use the high-level `McpServer.registerTool` (zod input shape → JSON schema handled by the SDK)
  — verified against the installed `@modelcontextprotocol/sdk` before building.
- Core stays MCP-free; only `mcp-server` imports the SDK (D3).
- Docker-env-via-MCP needs host docker access (run that smoke on the host, not nested).
