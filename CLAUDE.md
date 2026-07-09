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

## Status (2026-07-10) — v1.0.7 · Phase 1–2 complete

**OPEN-SOURCE (MIT).** M0–M9 + P1.1–P1.3 + P2.1/P2.3 shipped; P2.2 publish set includes
`@termbridge/sandbox-e2b`. Live E2B smoke proven. Fleet UI + recognizer corpus green.

Packages: `@termbridge/core`, `@termbridge/mcp-server`, `@termbridge/server`,
`@termbridge/orchestrator`, `@termbridge/claude-code-plugin`, `@termbridge/sandbox-e2b`.

## Decisions (D1–D8) — authority is `docs/superpowers/specs/2026-06-18-termbridge-design.md`

1. **D1** Human↔agent share one session via **tmux substrate**.
2. **D2** Brand-new standalone repo.
3. **D3** **MCP-first**; core stays zero-runtime-deps.
4. **D4** Isolation: Local + Docker + sandbox (E2B); more providers via same interface.
5. **D5** Pilot Claude Code TUI (send-keys/capture-pane) — no SDK/headless in v1.
6. **D6** expect-style + idle via PTY observer.
7. **D7** Pluggable recognizer registry.
8. **D8** Primitives + auth + registry only — **NOT an orchestrator**.

## Doc map

- `docs/ROADMAP.md` — forward plan.
- `docs/superpowers/specs/2026-06-18-termbridge-design.md` — v1 spec.
- `docs/demo/hermes-demo.md` — live demo runbook (operator-gated restart).
- `docs/integration/sandbox.md` — E2B.

## Key facts

- **Stack:** Bun + Turbo + Biome + TypeScript — **no pnpm**.
- Auth: shared `~/.claude` creds volume; OAuth recognizer.
- Fleet: `TERMBRIDGE_MAX_SESSIONS`; `GET /api/sessions` / web list.
- Sandbox: set `E2B_API_KEY` → `env:sandbox` auto-wired in server/MCP.
- **No detection-evasion.**

## Next step (operator-only leftovers)

1. **P1.4 live demo** — when idle: `hermes gateway restart`, DM bot, capture template in `docs/demo/`.
2. **Phase 3 (optional):** Daytona/Cloudflare, wake-on-event, pluggable delivery, arbitration.

To run: `bun install` → `bun run test`. Live E2B: `E2B_API_KEY=… bun scripts/smoke-sandbox-e2b.ts`.
