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

## Status (2026-07-25) — V2 Autonomous Local revision accepted

**OPEN-SOURCE (MIT).** The V2 roadmap, Autonomous Local design, implementation plan, and three research
briefs are accepted as the authority baseline. Phase 0 implementation is next.

**V1 baseline (measured at `0a4afc1`, clean tree, `--force`):** 754 tests / 49 files / 1811 expectations
passing, zero failures, zero skips; 8/8 packages typecheck clean; lint reports 3 warnings + 2 infos
(core 1w+2i, orchestrator 1w, mcp-server 1w — Phase 0 Task 2A clears these).

Released: `@termbridge/core`, `@termbridge/mcp-server`, `@termbridge/server`,
`@termbridge/orchestrator`, `@termbridge/claude-code-plugin` (v1.0.7); `@termbridge/sandbox-e2b`
(v1.0.10, live-proven). Experimental/deferred: `sandbox-daytona`, `sandbox-cloudflare` (Phase 0 Task 4
classifies them).

## Authority documents (V2)

- `docs/ROADMAP-V2.md` — canonical roadmap (supersedes `docs/ROADMAP.md` and `docs/PLAN.md`)
- `docs/superpowers/specs/2026-07-25-autonomous-local-design.md` — Autonomous Local design
- `docs/superpowers/plans/2026-07-25-autonomous-local.md` — implementation plan (30 task blocks,
  Phase 0–5; Phase 4 is gated as 4A/4B/4C)
- `docs/research/2026-07-24-jira-linear-github-autonomous-workflows.md` — tracker/forge research
- `docs/research/2026-07-11-roadmap-v2-durable-platform-architecture.md` — durable architecture research
- `docs/research/2026-07-11-cli-adapters-codex-opencode.md` — CLI adapter research
- `docs/DECISIONS.md` — ADRs (D1–D4 historical; V2-D1–V2-D17 to be accepted in Phase 0 Task 2B)

Historical (V1, superseded): `docs/ROADMAP.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`,
`docs/RESEARCH.md`, `docs/superpowers/specs/2026-06-18-termbridge-design.md`.

## Decisions (V2-D1–V2-D17) — authority is `docs/ROADMAP-V2.md` §5

Key amendments: **V2-D2** makes the shared application/domain service canonical (HTTP primary, MCP
sibling), superseding legacy **D3**; the durable domain lives in `@termbridge/control-plane` while Core
stays the provider-neutral substrate. Full ADR acceptance is Phase 0 Task 2B.

Legacy `DECISIONS.md` holds **D1–D4 only** — D5–D8 were never authored. Do not look for them.

## Key facts

- **Stack:** Bun + Turbo + Biome + TypeScript — **no pnpm**.
- **Autonomous Local target:** Jira/Linear → exact-plan approval → Claude Code/OpenCode → tested GitHub
  draft PR. No merge, no deploy, no ready-for-review in Local V1.
- **Storage:** SQLite authoritative (Local); Postgres later (Platform, shared contracts).
- **Sandbox:** set `E2B_API_KEY` → `env:sandbox` auto-wired in server/MCP.
- **No detection-evasion.** Provider-policy compliance is mandatory.

## Next step

1. **Phase 0** (30 task blocks total, 11 in Phase 0): start with Task 0 (commit the audited V2 docs),
   then Tasks 1, 2A, 2C, 3, 4, 5, 6, 7 in parallel, then Task 2B (after 1, 4, 5) and Task 8 (schema
   freeze, depends on Tasks 6+7 spike evidence).
2. See `docs/superpowers/plans/2026-07-25-autonomous-local.md` for the full task-by-task plan. Every
   task from 9 onward carries an explicit `Depends on:` line — that is the authoritative DAG.
3. Phase gates are recorded under `docs/evidence/autonomous-local/<phase>/` and checked by
   `bun scripts/gate-check.ts --phase <n>`.

To run: `bun install` → `bun run test`. Live E2B: `E2B_API_KEY=… bun scripts/smoke-sandbox-e2b.ts`.