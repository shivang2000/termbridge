# termbridge — Distribution & external-agent adoption (design)

Date: 2026-06-21
Status: brainstorming → spec (awaiting review)
Builds on: `2026-06-18-termbridge-design.md` (v0.1.0 — M1–M6 shipped).

## 1. Purpose

Make termbridge **usable by other agents** — Hermes, paperclip, opencode/openclaw, any MCP-capable agent —
as the MCP/tool/plugin they integrate to **spawn and pilot a real `claude` TUI on a subscription**. The
substrate exists (v0.1.0); this spec is the **integration surface + distribution + unattended-use
hardening** that turns "passes smokes" into "another agent can install it and run claude on the plan."

## 2. ⚠️ Boundary & risk (must read)

The reason `claude -p` / API-key-on-subscription is being restricted is that Anthropic limits **automated
use of consumer subscriptions**. Piloting the TUI at fleet scale is functionally the same automation, so:

- It very likely **violates Anthropic's usage terms** and **carries real ban risk for the account whose
  subscription is used.** This is documented, not hidden, and surfaced to operators.
- termbridge ships **good-citizen controls only**: concurrency cap, a rate-limit recognizer so consumers
  back off, fail-clean on logout. 
- termbridge will **NOT** ship detection/enforcement evasion: no humanized-keystroke timing to imitate a
  person, no multi-account rotation, no client fingerprint spoofing. Out of scope, by design.

termbridge remains a general interactive-CLI piloting substrate (dual-use); operators own the terms-of-use
decision for what they point it at.

## 3. Integration contract (what agents code against)

- **MCP over stdio is the universal contract** (already built, `@termbridge/mcp-server`, 12 §6 tools). Every
  MCP-capable agent adds the same stdio command:
  - claude: `claude mcp add termbridge -- <cmd>`
  - paperclip / Hermes / opencode: the same stdio command + env in their MCP-servers config.
- **HTTP tool API** (`packages/server`, `POST /api/tool/:name`, token-gated) — for the shared/human-watch
  case and non-MCP consumers; same tool surface, one shared `SessionManager`.
- **Shared subscription auth** (built): one-time `claude` login → creds volume (`TERMBRIDGE_HOME`) reused by
  every session.
- Contract stability: the §6 tool names/shapes are the public API; changes are additive.

## 4. Distribution (manual-first, then image, then npm)

Sequenced per the operator's choice:

1. **Manual run + per-agent integration guides (first).** A consumer runs the stdio server by hand and
   wires it into their agent. Ship `docs/integration/{claude,paperclip,hermes,opencode}.md`: exact install
   line, env (`TERMBRIDGE_HOME`, `TERMBRIDGE_TMUX_SOCKET`, server token), one-time login, a worked
   open→send→wait→read example. **Verify each** against the real stdio server (claude verified live; others
   documented + dry-run validated).
2. **Docker image + git install.** Publish the reference image (`tmux + node + bun + claude + git`) to a
   registry; document `git clone` + `bun install` + run. Lets consumers run the piloted claude in a clean
   sandbox without local setup.
3. **npm publish (gated).** Publish `@termbridge/core` + `@termbridge/mcp-server` (and `@termbridge/server`)
   so `npx @termbridge/mcp-server` / `claude mcp add … -- npx @termbridge/mcp-server` works. Requires
   `publishConfig`, `bin`, `files`, build-to-`dist`. **Outward-facing — do not publish without explicit
   operator approval**; confirm the `@termbridge` npm scope/ownership first.

## 5. Hardening for unattended use

- **Rate-limit recognizer** (new): detect Claude Code's rate-limit / usage-limit screens → emit a
  `rate_limited` event (with reset hint if shown) so consumers back off. Isolated like other recognizers;
  version-fragile by design.
- **Creds lifecycle**: `needs_login` event (built) + verify token **refresh** persists in the volume across
  expiry; document the re-login path (`claude` login flow surfaced via `oauth-url`). 
- **Concurrency cap** (built, `TERMBRIDGE_MAX_SESSIONS`) — respect plan limits.
- **Session recovery** (new, optional): on server start, re-adopt existing `-L termbridge` tmux sessions /
  `termbridge-*` containers into the registry so a restart doesn't orphan running sessions.

## 6. Non-goals

Detection/enforcement evasion (§2). Orchestration / task scheduling (D8 — consumers own the driving loop;
we may ship a reference example, not an engine). Multi-user auth/RBAC, hosted-service concerns.

## 7. Verification

- **Per-agent integration (manual):** start the stdio MCP server by hand; from each consumer (at minimum a
  real claude via `claude mcp add`) call open_session → send_text → wait_for_idle → read_screen against a
  Dockerized claude session; confirm subscription auth (reused creds). Document the exact steps that worked.
- **Hardening:** unit-test the rate-limit recognizer on captured fixtures; a recovery smoke (start sessions,
  restart the server, confirm re-adoption); creds-reuse-after-refresh check.
- **Packaging:** `npm pack` dry-run + `npx`-from-tarball smoke before any real publish.

## 8. Milestones

- **D1 — integration contract + manual guides** (first): per-agent docs + live-verify the stdio server is
  consumable; tidy env/config; reference driving-loop example.
- **D2 — hardening:** rate-limit recognizer, creds-refresh verification, session recovery.
- **D3 — Docker image distribution:** push the reference image; image run docs.
- **D4 — npm publish (gated):** packaging (`bin`/`files`/`publishConfig`/build), `npm pack` smoke, then
  publish on explicit approval.
