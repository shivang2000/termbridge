# termbridge — project context (resume anchor)

> This file is auto-loaded by Claude Code when you open this repo. It exists so any session can resume
> exactly where we left off. Read it, then read the spec, then continue at **Next step**.

## What termbridge is

A reusable component that lets an automated agent **pilot an interactive terminal CLI exactly like a
human** — type into the TUI, read the screen, answer prompts, select options — while a human can
simultaneously **watch and intervene** from a browser.

**The real why (drives every decision):** run coding work on a **Claude Code *subscription*, not metered
API**. A session runs a logged-in `claude` TUI and the agent drives it like a human, so usage bills
against the plan. The vision: an orchestrator (Hermes / paperclip) **spawns many agents, each piloting its
own Claude Code session to do coding work** in parallel, sharing one subscription.

It generalizes two sibling repos: `~/dev/sentry-fixer-bot` (`alertforge`) = the human↔web-terminal half
(xterm ↔ WS ↔ PTY + OAuth-URL bridge), and `~/dev/paperclip` = the agent↔execution-env half (adapters +
E2B/Daytona/Cloudflare sandbox providers + workspace-runtime + MCP server).

## Status (2026-07-10) — M0–M9 + P1.1–P1.3 + P2.1/P2.3 build complete

**OPEN-SOURCE (MIT).** Packages: `@termbridge/core`, `@termbridge/mcp-server` (13-tool stdio),
`@termbridge/server` (web WS + HTTP tools + streamable-HTTP `/mcp` + fleet `GET /api/sessions`),
`@termbridge/orchestrator` (`runEngineerLoop`), `@termbridge/claude-code-plugin`,
`@termbridge/sandbox-e2b` (live E2B smoke proven; auto-wired when `E2B_API_KEY` set).
Recognizer fixture corpus + drift guard (P2.1). Fleet session list in web UI (P2.3).

## Decisions (D1–D8) — authority is `docs/superpowers/specs/2026-06-18-termbridge-design.md`

1. **D1** Human↔agent share one session via **tmux substrate** (agent uses tmux CLI, never attaches; human `tmux attach`).
2. **D2** Brand-new standalone repo (this one).
3. **D3** **MCP-first**: build `core` lib → MCP server first; Claude Code plugin wrapper later. Core stays zero-runtime-deps.
4. **D4** Isolation: **Local + Docker-per-session + sandbox (E2B)**; more cloud providers later via same interface.
5. **D5** Control Claude Code by **piloting its TUI like a human** (send-keys/capture-pane) — no SDK/headless in v1.
6. **D6** Read sync: **expect-style + idle** via per-session PTY observer (`tmux pipe-pane -O`).
7. **D7** **Pluggable recognizer registry** for prompts.
8. **D8** Scope = **primitives + auth + session registry only. NOT an orchestrator**.

## Doc map

- `docs/ROADMAP.md` — forward plan (status legend).
- `docs/superpowers/specs/2026-06-18-termbridge-design.md` — v1 spec (authority).
- `docs/demo/hermes-demo.md` — Hermes live demo runbook (operator-gated restart).
- `docs/integration/sandbox.md` — E2B setup.

## Key facts

- **Stack:** Bun + Turbo + Biome + TypeScript — **no pnpm**.
- Auth: `~/.claude/.credentials.json` on a volume; OAuth via recognizer; subscription not API.
- Fleet: cap with `TERMBRIDGE_MAX_SESSIONS`; observe via `GET /api/sessions` / web session list.
- **No detection-evasion.** Ask before `npm publish`.

## Next step

**Build for Phase 1–2 is done** (demo deferred). Remaining operator/gated:

1. **P1.4 live demo** — when idle: `hermes gateway restart`, DM bot, fill capture template in `docs/demo/`.
2. **P2.2 publish** — owner sign-off, then tag / `bun scripts/publish-npm.ts` (includes `sandbox-e2b`).
3. **Phase 3 (optional):** Daytona/Cloudflare providers, wake-on-event plugin, pluggable delivery, arbitration.

To run: `bun install` → `bun run test`. Live E2B: `E2B_API_KEY=… bun scripts/smoke-sandbox-e2b.ts`.
