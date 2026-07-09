# Changelog

## Unreleased

Live Daytona smoke + multi-provider smoke runner.

- **`createDaytonaClientFromEnv()`** (`@daytona/sdk`) + `scripts/smoke-sandbox-daytona.ts`
  (ephemeral sandbox, always `delete` in finally).
- **`scripts/smoke-sandbox-cloudflare.ts`**: token verify + account Workers list (no
  resources created — Containers need Wrangler).
- **`scripts/smoke-sandbox-all.ts`**: run all three smokes with `.env`.

Phase 3 foundation — more sandbox providers, pluggable delivery, wake-on-event docs.

- **`@termbridge/sandbox-daytona`** / **`@termbridge/sandbox-cloudflare`**: `SandboxProvider`
  ports with injectable clients (no hard vendor SDK in CI); unit tests; orphan cleanup on
  failed ensure.
- **Orchestrator delivery strategies**: `delivery: "gh-pr" | "patch" | "gerrit"` (or custom
  `DeliveryStrategy`); `openPr: true` remains sugar for `"gh-pr"`.
- **Wake-on-event**: `packages/claude-code-plugin/WAKE-ON-EVENT.md` documents
  `wait_for_event` host wake pattern.
- Docs: `docs/integration/sandbox.md` multi-provider table.

- **@termbridge/sandbox-e2b@1.0.8** published to npm (publisher confirmed); public registry
  metadata may lag for brand-new scoped packages — if `npm view` 404s, install from the
  monorepo or retry after npm indexes the package.

## v1.0.7 — 2026-07-10

Phase 1–2 substrate complete: live E2B sandbox, fleet observability, recognizer corpus,
streamable-HTTP MCP, and publish set including `@termbridge/sandbox-e2b`.

### P1.1 — Live cloud SandboxProvider (E2B)

- **New `@termbridge/sandbox-e2b`**: `E2BSandboxProvider` against the E2B SDK; tmux via
  `sudo -n apt-get` on non-root `base`; destroy double-kill; orphan cleanup on failed open.
- **`SessionManager.sandboxProvider`** + MCP `open_session` enum `local|docker|sandbox`.
- **Auto-wire:** server + mcp-server enable sandbox when `E2B_API_KEY` is set
  (`sandboxProviderFromEnv()`).
- Smoke: `scripts/smoke-sandbox-e2b.ts` (creds-gated; live proven).

### P1.2 — Streamable-HTTP MCP (already in Unreleased from prior work)

- `POST/GET/DELETE /mcp` on the unified server; shared registry; token-gated.
- `startServer` returns actual bound port.

### P1.3 — Orchestrator factor (prior)

### P2.1 — Recognizer fixture corpus

- `__fixtures__/` + `corpus.guard.test.ts` drift guard.

### P2.3 — Fleet observability

- `GET /api/sessions` + web session list; `Session.lockState()` / `SessionManager.capacity()`.

### P2.2 — Publish set

- `@termbridge/sandbox-e2b` publish-ready and included in `scripts/publish-npm.ts`.

### Docs

- Hermes demo runbook polish (P1.4 live demo remains operator-gated: gateway restart).

## v1.0.6 — 2026-06-24

Browser watch for Hermes-driven sessions.

- **`@termbridge/mcp-server` proxy mode:** with `TERMBRIDGE_SERVER_URL` set, the stdio MCP forwards every
  tool to a running unified server instead of its own SessionManager — so the web bridge and the agent
  share ONE session registry (the browser watches exactly what the agent drives). Unset = unchanged.
- **`@termbridge/server` is now published** (Bun; `bunx @termbridge/server`) with its web client bundled.
- **`setup.sh --watch`** (local mode): starts the host web server, registers the MCP to proxy to it, and
  prints a loopback `http://127.0.0.1:PORT/?token=…` watch URL. The engineer-loop skill posts the
  per-session URL; typing in the browser takes over (the in-session auto-approver pauses).

## v1.0.5 — 2026-06-23

In-session **auto-approver** — Claude never stalls on permission prompts.

- **`open_session({ autoApprove: true })`** (or `TERMBRIDGE_AUTO_APPROVE=1`): termbridge answers the
  session's routine `claude-permission` prompts (tool / trust / bypass) **in-session**, via the existing
  PtyObserver stream + recognizer `suggestedKeys` + the WriteLock-gated `sendControl`. So a driving agent
  (e.g. Hermes) that only polls occasionally never leaves the TUI stuck waiting for input.
- **Human-takeover-aware + login-safe by construction:** the approve key goes through the agent write gate,
  so a human keystroke pauses auto-approve; and login (`paste`/oauth → empty `suggestedKeys`) is never
  auto-answered. Off by default (opt-in), so existing behavior is unchanged.
- skill: the `engineer-loop` opens with `autoApprove: true` (paired with `--permission-mode plan` →
  plan-first, then hands-off execution).

## v1.0.4 — 2026-06-22

Ticket → PR delivery + a safe local (no-docker) run mode.

- **Delivery:** after acceptance passes, the loop has claude create a branch + commit, then open a PR —
  in-session via `gh` when a `GH_TOKEN` is forwarded, else the CLI/host opens it with your `gh` auth. PR is
  **human-gated**: confirm → ready-for-review, otherwise a **draft** (`--pr ask|ready|draft|none`).
  `runEngineerLoop` returns `{ delivery, prUrl, branch }`.
- **local mode:** `--env local` runs claude on the host's tmux `-L termbridge` socket (your **default tmux
  is never touched**) and uses the host's git/gh directly — no bind-mount, no token. `--env docker` stays
  for isolation.
- **core:** `SessionManager` forwards an allowlisted set of host env vars into a session (`forwardEnv` /
  `TERMBRIDGE_FORWARD_ENV`, incl. `GH_TOKEN`/`GH_HOST`) so in-session `gh` can push + PR.
- **tmux safety:** a guard test locks that every `LocalEnvironment` verb runs on `-L termbridge` (no
  default-socket escape); operator rule documented (never broad `pkill`/`kill-server`).
- **sandbox image:** now ships `gh` + a default git identity + `safe.directory '*'` for in-container PRs.

## v1.0.3 — 2026-06-21

CI/CD: tag-triggered release pipeline (`.github/workflows/release.yml`) publishes the npm packages +
both Docker images on every `vX.Y.Z` tag. First release cut through the pipeline. No code changes.

## v1.0.2 — 2026-06-21

Fixed the published npm manifest (1.0.1 shipped `exports` pointing at unshipped `src`; npm ignores
`publishConfig`). Publish now swaps top-level fields to `dist` for the tarball (`scripts/publish-npm.ts`)
and keeps `src` for dev. Added the per-session sandbox image `…/termbridge-sandbox`. 1.0.1 deprecated.

## v1.0.1 — 2026-06-21

Usability: log in to Claude **through** termbridge, and hand off a ticket in one command.

- **`GET /login`** (unified server, token-gated): opens a `claude` session and redirects to the watch UI,
  where the oauth-url card lets a human sign in. Login persists on the creds volume and is reused by every
  later session — the one-time "log in to Claude via termbridge" entry point.
- **`scripts/engineer.ts`** CLI: hand a coding task (e.g. a Jira ticket) to a running server's engineering
  loop over the HTTP tool API and stream progress.
- README: a "set it up on your laptop and hand off a ticket" walkthrough; Quickest section leads with
  `/login`. Published image `shivang2000/termbridge:1.0.1` (+ `:latest`).

## v1.0.0 — 2026-06-21

First stable release. An automated agent can pilot a real logged-in `claude` TUI to do coding work on a
**subscription** (not metered API) while a human watches and intervenes from a browser — proven
end-to-end, including through a third-party agent runtime (Hermes) and an autonomous engineering loop.

### Packages
- **@termbridge/core** — `SessionManager`, `Session`, `Environment` (`Local` / `Docker` / `Sandbox`
  interface), `PtyObserver` (bounded rolling buffer), `WriteLock` (human/agent arbitration), recognizers
  (`oauth-url`, `claude-permission`, `generic-yn`, `rate_limited`, **`claude-activity`**),
  `AuthProvisioner`. Race-safe concurrency cap; **docker-only env guard** (`allowedEnvs` /
  `TERMBRIDGE_ALLOWED_ENVS`) so an untrusted caller can never run on the host.
- **@termbridge/mcp-server** — 13-tool stdio MCP surface (adds **`read_progress`** for driving loops).
- **@termbridge/server** — unified Bun+Hono server: web WS bridge (watch + intervene, **live activity
  bar**) + HTTP tool API; bearer token + loopback bind + Origin allowlist.
- **@termbridge/orchestrator** — **`runEngineerLoop`**: backend-agnostic iterate-until-done engineering
  loop with live progress digests and test-gated completion (consumer-side; D8).
- **@termbridge/claude-code-plugin** — registers the termbridge MCP server in Claude Code.
- **skills/engineer-loop** — Hermes skill for the chat-driven loop.

### Verification
~900 unit tests (all mocked) + real smokes: tmux, Docker, MCP (stdio), web (Playwright), auth reuse,
concurrency cap, the engineering loop (claude fixed a failing test, host-verified), the docker-only guard
(over real stdio), and live Hermes drives (single, parallel fleet, concurrency). CI gates
typecheck/lint/test on push/PR.

### Known limitations / not in v1.0
- No concrete cloud `SandboxProvider` yet (E2B interface ships + is unit-tested; needs `E2B_API_KEY`).
  The `sandbox` kind is therefore not selectable over the default factory / MCP enum yet.
- The unified server is Bun-only (web bridge) and is distributed via source / Docker, not npm.
- Recognizer patterns track the Claude Code 2.1.x TUI and are version-fragile by design (isolated per
  module; re-tune on claude upgrades).
