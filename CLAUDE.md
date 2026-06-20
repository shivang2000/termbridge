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

## Status (2026-06-21) — v0.1.0

**M1–M6 complete + final acceptance passed.** Built: `packages/core` (SessionManager/Session/Environment
[Local/Docker/Sandbox]/PtyObserver/WriteLock/recognizers/AuthProvisioner), `packages/mcp-server` (stdio,
12-tool §6 surface), `packages/server` (unified Bun+Hono: web WS bridge + HTTP tool API, token-gated +
loopback), `packages/claude-code-plugin`. ~500 unit tests; real-tmux/Docker/MCP/web/auth/acceptance smokes
green. Final acceptance: an agent piloted real logged-in `claude` via the tool surface to edit a bound git
repo while a human watched — subscription auth, no API key. Pending: live cloud-sandbox provider (E2B, needs
creds) and `npm publish` (gated — ask first). Web bridge uses tmux primitives, not node-pty (fails under Bun).

## Decisions (D1–D8) — authority is `docs/superpowers/specs/2026-06-18-termbridge-design.md`

1. **D1** Human↔agent share one session via **tmux substrate** (agent uses tmux CLI, never attaches; human `tmux attach`).
2. **D2** Brand-new standalone repo (this one).
3. **D3** **MCP-first**: build `core` lib → MCP server first; Claude Code plugin wrapper later.
4. **D4** Isolation: **Local + Docker-per-session, user-selectable**; cloud sandbox later via same interface.
5. **D5** Control Claude Code by **piloting its TUI like a human** (send-keys/capture-pane) — no SDK/headless in v1.
6. **D6** Read sync: **expect-style + idle** (`wait_for_text` + `wait_for_idle`) via a per-session PTY observer (`tmux pipe-pane -O`).
7. **D7** **Pluggable recognizer registry** for prompts; ship `oauth-url` (port alertforge `url-detector.ts`), `claude-permission`, `generic-yn`.
8. **D8** Scope = **primitives + auth + session registry only. NOT an orchestrator** (paperclip/hermes orchestrate).

## Doc map

- `docs/superpowers/specs/2026-06-18-termbridge-design.md` — **the v1 spec (authority)**.
- `docs/sessions/2026-06-18-research-and-design-session.md` — full session record (goal, method, findings, decision log).
- `docs/PLAN.md` · `docs/ARCHITECTURE.md` · `docs/RESEARCH.md` · `docs/DECISIONS.md` — background.
- `README.md` — overview + planned package layout.

## Key facts to remember

- **Stack:** Bun (package manager + workspaces + test runner) + Turbo (task pipeline) + Biome + TypeScript — **no pnpm**.
- Reuse from alertforge: `apps/server/src/chat/{pty-runner,url-detector}.ts`, `apps/server/src/routes/chat-ws.ts`,
  `apps/web/src/components/{xterm-panel,chat-terminal}.tsx`. **Upgrade `script(1)` → `node-pty`** for live resize.
- Reuse from paperclip: adapter/provider pattern (`packages/adapter-utils/src/types.ts`), sandbox providers
  (`packages/plugins/sandbox-providers/{e2b,daytona,cloudflare}`), `packages/mcp-server` layout.
- Auth: persist `~/.claude/.credentials.json` on a volume; one-time OAuth login via recognizer; all sessions reuse → subscription not API.
- Caveat: fleet use of a subscription CLI may hit plan rate limits / automated-use terms → cap concurrency.
- Repo: `github.com/shivang2000/termbridge` (private, account `shivang2000`).

## Next step

v0.1.0 shipped (tag `v0.1.0`). Remaining/optional: ship a concrete cloud `SandboxProvider` (E2B — needs
`E2B_API_KEY`) and live-test it; consider a streamable-HTTP MCP transport on `packages/server`; ask before
`npm publish`. To run: `bun install` → `bun run test` → see README Quickstart. Verify end-to-end with
`scripts/accept-final.ts` (in Docker, reusing `~/.termbridge/home` creds).
