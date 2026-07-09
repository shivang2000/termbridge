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

## Current state — v1.0.6 (M0–M9 complete)

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
| **M6** | `SandboxEnvironment` *interface* + `wait_for_event` + `claude-code-plugin` (live cloud deferred) | ✅ (🟡 live cloud) |
| **M7** | `runEngineerLoop` (autonomous iterate-until-done loop + ~25s digests + PR delivery) | ✅ |
| **M8** | Distribution (npm packages + Docker images + tag-triggered release pipeline) | ✅ |
| **M9** | Browser watch for Hermes-driven sessions (MCP proxy mode + `setup.sh --watch`) | ✅ |

**Packages shipped:** `@termbridge/core`, `@termbridge/mcp-server`, `@termbridge/server`,
`@termbridge/orchestrator`, `@termbridge/claude-code-plugin`, plus the `engineer-loop` Hermes skill.

---

## Roadmap

### Phase 1 — Near term (finish the substrate's open seams)

#### P1.1 — Live cloud `SandboxProvider` (E2B) 🟡→🔲
**Why:** The `SandboxEnvironment` interface and unit tests ship, but the `sandbox` env kind is **not
selectable** over the default factory / MCP enum because there is no concrete provider. This closes
the strongest-isolation path for untrusted/multi-tenant fleets (D4).
**Scope:**
- A thin `@termbridge/sandbox-e2b` (or equivalent) package implementing `SandboxProvider`
  (`ensure`/`exec`/`destroy`), pinned to the `-L termbridge` socket.
- Make `env: "sandbox"` selectable via `SessionManager` factory + MCP `open_session` enum.
- Live cloud smoke (needs `E2B_API_KEY`); mirror the Docker smoke.
**Unblock:** obtain provider creds; document provider selection.
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

#### P1.4 — Discord / Hermes live demo finish 🔲
**Why:** The engineer-loop + `engineer-loop` skill + `setup.sh --watch` are built; the remaining
step is operator-gated (`hermes gateway restart` kills running agents) to exercise the chat-driven
loop end to end.
**Scope:**
- Restart the Hermes gateway (config already wired: `TERMBRIDGE_ALLOWED_ENVS=docker` +
  `MAX_SESSIONS=3`; backup `~/.hermes/config.yaml.bak-pre-m7`).
- DM the bot a coding task; capture the demo walkthrough for `docs/demo/`.

---

### Phase 2 — Medium term (reach + hardening)

#### P2.1 — Recognizer re-tuning & version resilience 🔁
**Why:** Recognizer patterns (`claude-permission`, `claude-activity`, `oauth-url`, `generic-yn`,
`rate_limited`, `tb-marker`) track the Claude Code TUI and are **version-fragile by design**
(isolated per module). As the TUI changes, recognizers must be re-tuned.
**Scope (ongoing):**
- Regression test corpus of screen captures per recognizer; alert on drift.
- Optional: a pluggable/declarative recognizer spec so tuning is data, not code, where feasible.

#### P2.2 — npm publish of the remaining packages 🟡
**Why:** `@termbridge/server` is published (M9); `@termbridge/mcp-server`/`core`/`orchestrator` are
published but the broader publish set is **gated** (ask first — see `CLAUDE.md`).
**Scope:**
- Finalize the publish allowlist + `files` whitelists; version coordination via the release
  pipeline.
- **Gate:** owner sign-off before any public npm publish beyond the current set.

#### P2.3 — Concurrency / fleet observability 🔲
**Why:** An orchestrator spawns many sessions sharing one subscription; operators need to see cap
utilization, isolation status, and per-session health at a glance.
**Scope:**
- Server-side session inventory + status (idle/driving/human-takeover) surfaced in the web UI.
- Document concurrency caps + plan-rate-limit guidance (Responsible use).

---

### Phase 3 — Long term / exploratory

- **Additional cloud providers** (Daytona, Cloudflare) behind the same `SandboxProvider` interface
  (D4) — a port, not a rewrite.
- **Wake-on-terminal-event ergonomics** in the Claude Code plugin (pi-interactive-shell
  `triggerTurn`-style), deferred from M6/D3.
- **Pluggable delivery targets** beyond `gh` PRs (e.g. Gerrit, raw patch) in the orchestrator.
- **Contention / arbitration improvements** — currently manual human interrupt + advisory
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

