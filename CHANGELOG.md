# Changelog

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
