# Changelog

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
