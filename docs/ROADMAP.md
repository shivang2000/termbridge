# termbridge — Roadmap

> Source of truth for **where the project is and where it's going**. Companion to
> [PLAN.md](PLAN.md) (the detailed *implementation* plan) and
> [DECISIONS.md](DECISIONS.md) (the locked architecture decisions D1–D8).
>
> Status legend: ✅ shipped · 🟡 designed/deferred · 🔲 not started · 🔁 ongoing

---

## Vision

One terminal session that an **AI agent** (via MCP) and a **human** (via a browser) drive at the
**same time** — so an agent can pilot **Claude Code** (and other interactive CLIs) like a human, on a
**subscription, not metered API**. termbridge is the **substrate** (session primitives + auth + a
small registry), not an orchestrator; "which agent does what" is left to whatever drives it (Hermes,
paperclip, your own).

---

## Current state — v1.0.7 (M0–M9 + Phase 1–2 build complete)

A stable, MIT-licensed, open-source substrate. ~900 unit tests (all mocked) + real smokes
(tmux, Docker, MCP stdio, web/Playwright, auth reuse, concurrency cap, the engineering loop, and
live Hermes drives). CI gates typecheck/lint/test on push/PR.

| Milestone | What it delivered | Status |
|---|---|---|
| **M0** | Repo scaffold (Bun workspaces + Turbo + Biome + TS strict) | ✅ |
| **M1** | `core` + `LocalEnvironment` (SessionManager/Session/tmux helpers/output-buffer/WriteLock) | ✅ |
| **M2** | `DockerEnvironment` (container-per-session + reference image) | ✅ |
| **M3** | `mcp-server` — 13-tool stdio MCP surface incl. `read_progress` | ✅ |
| **M4** | Auth reuse + OAuth-URL bridging (log in to Claude *through* termbridge) | ✅ |
| **M5** | Web bridge (xterm.js + Hono/Bun WS, live activity bar) + unified server | ✅ |
| **M6** | `SandboxEnvironment` *interface* + `wait_for_event` + `claude-code-plugin` (+ live E2B via P1.1) | ✅ |
| **M7** | `runEngineerLoop` (autonomous iterate-until-done loop + ~25s digests + PR delivery) | ✅ |
| **M8** | Distribution (npm packages + Docker images + tag-triggered release pipeline) | ✅ |
| **M9** | Browser watch for Hermes-driven sessions (MCP proxy mode + `setup.sh --watch`) | ✅ |

**Packages shipped:** `@termbridge/core`, `@termbridge/mcp-server`, `@termbridge/server`,
`@termbridge/orchestrator`, `@termbridge/claude-code-plugin`, plus the `engineer-loop` Hermes skill.

---

## Roadmap

### Phase 1 — Near term (finish the substrate's open seams)

#### P1.1 — Live cloud `SandboxProvider` (E2B) ✅
**Why:** The `SandboxEnvironment` interface and unit tests shipped (M6), but the
`sandbox` env kind was **not selectable** over the default factory / MCP enum because
there was no concrete provider. This closes the strongest-isolation path for
untrusted/multi-tenant fleets (D4).
**Shipped:** `@termbridge/sandbox-e2b` (`E2BSandboxProvider` against the E2B SDK, mocked
unit tests); `SessionManagerOptions.sandboxProvider` makes `env:"sandbox"` select
`SandboxEnvironment` (throws `SandboxProviderNotConfiguredError` when unset); MCP
`open_session` enum is now `local|docker|sandbox`. Smoke
`scripts/smoke-sandbox-e2b.ts` (creds-gated) — **live cloud smoke proven** (open +
drive + registry + close). tmux install uses passwordless `sudo` on the E2B `base`
template (non-root user). Core stays dependency-free (D3).
**Non-goal:** multi-provider fan-out in v1 — one concrete provider first.

#### P1.2 — Streamable-HTTP MCP transport on `@termbridge/server` ✅
**Why:** Today the browser watches Hermes-driven sessions via **stdio proxy mode** (M9). A
streamable-HTTP MCP transport on the unified server lets MCP clients (Hermes, Claude Code, Cursor)
connect **directly** to the server over HTTP — sharing its single `SessionManager`, so the browser
watches *their* sessions natively (no per-client proxy), and remote MCP clients work across a
network boundary.
**Shipped:** `POST/GET/DELETE /mcp` on the unified server (SDK `WebStandardStreamableHTTPServerTransport`,
stateful per MCP client session), reusing `createServer` from `@termbridge/mcp-server` so the 13-tool
surface is identical to stdio + `/api/tool`. Token-gated like `/api/tool/:name` (no new security surface);
loopback bind by default. Smoke: `scripts/smoke-mcp-http.ts` (real tmux, shared-registry proof). **stdio
stays the zero-infra default** (non-goal: replacing it).

#### P1.3 — Factor `@termbridge/orchestrator` ✅
**Why:** `runEngineerLoop` was a ~20KB single module mixing loop control, progress digesting,
auto-approval, and delivery. Factoring it makes the consumer-side loop easier to extend (new
acceptance strategies, delivery targets) and keeps D8 (not an orchestrator) clean.
**Shipped:** `engineer-loop.ts` (497 lines) split into `types.ts` (interfaces), `parse.ts` (pure
helpers + sentinels), `prompt.ts` (prompt builders), and `approve.ts` (in-session approval glue);
`engineer-loop.ts` is now the ~250-line loop driver and re-exports the full public surface so the
test file and package barrel are byte-for-byte unchanged (regression proof). 26 orchestrator tests green.

#### P1.4 — Discord / Hermes live demo finish 🟡 (runbook ✅ · live demo operator-gated)
**Why:** The engineer-loop + `engineer-loop` skill + `setup.sh --watch` are built; the remaining
step is operator-gated (`hermes gateway restart` kills running agents) to exercise the chat-driven
loop end to end.
**Prep shipped:** `docs/demo/hermes-demo.md` + `jira-ticket-prompt.md` — post-restart checklist,
auth story (API key vs subscription volume), `--watch` ops, Discord checks, capture template.
**Still operator-gated:**
- Restart the Hermes gateway (config already wired: `TERMBRIDGE_ALLOWED_ENVS=docker` +
  `MAX_SESSIONS=3`; backup `~/.hermes/config.yaml.bak-pre-m7`).
- DM the bot a coding task; fill the capture template in `docs/demo/`.

---

### Phase 2 — Medium term (reach + hardening)

#### P2.1 — Recognizer re-tuning & version resilience 🔁 (corpus ✅)
**Why:** Recognizer patterns (`claude-permission`, `claude-activity`, `oauth-url`, `generic-yn`,
`rate_limited`, `tb-marker`) track the Claude Code TUI and are **version-fragile by design**
(isolated per module). As the TUI changes, recognizers must be re-tuned.
**Shipped:** screen fixture corpus under `packages/core/src/recognizers/__fixtures__/` +
`corpus.guard.test.ts` (fails loudly on drift). Re-capture notes in `__fixtures__/README.md`.
**Still ongoing:** re-tune when Claude Code TUI changes; optional declarative recognizer
spec remains deferred (data-not-code where feasible, behind existing `Recognizer` API).

#### P2.2 — npm publish of the remaining packages ✅ (v1.0.7)
**Why:** Ship the full public set including `@termbridge/sandbox-e2b`.
**Shipped:** published `@termbridge/{core,mcp-server,orchestrator,sandbox-e2b,server}@1.0.7`.
`claude-code-plugin` stays private.

#### P2.3 — Concurrency / fleet observability ✅
**Why:** An orchestrator spawns many sessions sharing one subscription; operators need to see cap
utilization, isolation status, and per-session health at a glance.
**Shipped:** `Session.lockState()` + `SessionManager.capacity()`; token-gated `GET /api/sessions`
(holder + idle/driving/human-takeover + maxSessions/count); web client session list panel; Responsible
use + Hermes docs for caps / rate-limit backoff.

---

### Phase 3 — Long term / exploratory 🔁 (foundation shipped)

v1 substrate is complete without these; Phase 3 extends reach.

- **Additional cloud providers** ✅ foundation: `@termbridge/sandbox-daytona` +
  `@termbridge/sandbox-cloudflare` (injectable clients, unit-tested; map vendor SDKs at the edge).
  E2B remains the live-proven provider. See `docs/integration/sandbox.md`.
- **Wake-on-terminal-event ergonomics** ✅ docs: `packages/claude-code-plugin/WAKE-ON-EVENT.md`
  (`wait_for_event` wake pattern for host turns).
- **Pluggable delivery targets** ✅: `delivery: "gh-pr" | "patch" | "gerrit"` (or custom
  `DeliveryStrategy`) on `runEngineerLoop`; default remains gh-PR via `openPr: true`.
- **Contention / arbitration improvements** 🔲 — still manual human interrupt + advisory
  `WriteLock`; revisit if real arbitration prior art emerges.

---

## Non-goals (reaffirmed)

- **No detection-evasion.** No humanized keystroke timing, account rotation, or fingerprint
  spoofing — contributions adding these are declined (see [Responsible use](../README.md#responsible-use)).
- **Not an orchestrator.** termbridge ships primitives + auth + a registry; orchestration stays in
  Hermes/paperclip/the caller (D8).
- **No bespoke multiplexing protocol.** tmux co-presence + advisory lock is the verified pattern (D1).

---

## How this roadmap is maintained

- Milestone completion is recorded in [CHANGELOG.md](../CHANGELOG.md) and the resume anchor
  [CLAUDE.md](../CLAUDE.md); this roadmap is the **forward-looking** summary.
- Per-milestone implementation detail lives in `docs/superpowers/plans/`; design authority is
  `docs/superpowers/specs/2026-06-18-termbridge-design.md`.
- Status updates here should follow each shipped milestone (move items ✅, retire completed phases).

