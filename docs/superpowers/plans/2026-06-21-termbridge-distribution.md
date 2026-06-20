# termbridge Distribution & External-Agent Adoption — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or the Workflow tool to implement
> this task-by-task. Steps use `- [ ]`. Code units (D2) are TDD; docs/packaging (D1/D3/D4) are verify-driven.

**Goal:** Make termbridge installable + usable by other MCP-capable agents (Hermes/paperclip/opencode) to
pilot a real `claude` on a subscription, with unattended-use hardening.

**Architecture:** The stdio MCP server (`@termbridge/mcp-server`, built) is the universal contract. Add a
rate-limit recognizer + session recovery to core, package for npm/Docker, and document per-agent
integration. No new transport; no evasion.

**Tech Stack:** Bun + Turbo + Biome + TypeScript; `@modelcontextprotocol/sdk`; tmux; Docker.

## Global Constraints

- No detection/enforcement evasion (humanized timing, account rotation, fingerprint spoofing) — ever.
- npm publish + Docker-registry push are outward-facing — **do not run without explicit operator approval.**
- Recognizers stay isolated + version-fragile by design (spec §12); core stays framework-agnostic (D3).
- All real-tmux/claude verification runs in Docker on the `-L termbridge` socket (host tmux untouched).
- Test runner `bun test`; gate = `turbo run test lint typecheck`.

---

## D1 — Integration contract + per-agent guides (manual-run first)

### Task 1: Per-agent integration guides
**Files:** Create `docs/integration/{claude,paperclip,hermes,opencode}.md`, `docs/integration/README.md`.

- [ ] **Step 1:** Write `docs/integration/README.md`: the universal stdio command
  `bun /ABS/packages/mcp-server/src/stdio.ts` (or `npx @termbridge/mcp-server` post-D4), required env
  (`TERMBRIDGE_HOME`, `TERMBRIDGE_TMUX_SOCKET`, `TERMBRIDGE_MAX_SESSIONS`), one-time login pointer, and the
  12-tool surface table (copy from the M3 plan).
- [ ] **Step 2:** Write `docs/integration/claude.md`: `claude mcp add termbridge -- bun /ABS/.../stdio.ts`;
  a worked open_session→send_text→wait_for_idle→read_screen→close_session transcript.
- [ ] **Step 3:** Write `docs/integration/paperclip.md`, `hermes.md`, `opencode.md`: each shows the agent's
  MCP-servers config block (stdio command + env) and the same worked example, noting headless fleets get a
  per-agent SessionManager (no shared web) which is fine; the unified-server HTTP tool API is the
  shared/human-watch alternative (link `packages/server`).
- [ ] **Step 4:** Commit `docs(integration): per-agent guides`.

### Task 2: Reference driving-loop example
**Files:** Create `examples/drive-claude.ts`.

- [ ] **Step 1:** Write `examples/drive-claude.ts` — a minimal, dependency-free MCP-client (SDK
  `Client` + `StdioClientTransport`) that opens a session, sends a task, then loops `read_events`: on
  `claude-permission`/`generic-yn` send `suggestedKeys[0]`; on `rate_limited` back off; on `needs_login`
  abort with a clear message; stop when a target file changes or `wait_for_event` returns. Heavily
  commented as the canonical "how a consumer drives" pattern (termbridge stays primitives-only, D8).
- [ ] **Step 2:** Verify it runs in Docker against a real claude session (reuses creds); commit.

### Task 3: Live-verify the contract
- [ ] **Step 1:** In Docker, start the stdio server by hand; `claude mcp add` it into a real local claude;
  confirm the 12 tools are listed and a tool call drives a Dockerized claude session. Capture the transcript
  into `docs/integration/claude.md`. (paperclip/hermes/opencode: config documented + dry-run validated.)

---

## D2 — Hardening for unattended use (TDD code units)

### Task 4: rate-limit recognizer
**Files:** Create `packages/core/src/recognizers/rate-limit.ts`, `rate-limit.test.ts`; modify
`packages/core/src/manager.ts` (register it), `packages/core/src/index.ts` (export).

**Interfaces:** Produces `export const rateLimitRecognizer: Recognizer` (kind `"rate_limited"`), matching
Claude Code's usage/rate-limit screens → `{ data: { message, resetsAt? }, suggestedKeys: [] }`.

- [ ] **Step 1: Write the failing test** (`rate-limit.test.ts`):

```ts
import { describe, expect, it } from "bun:test";
import { rateLimitRecognizer } from "./rate-limit.js";

const LIMIT = [
  "\x1b[31mClaude usage limit reached.\x1b[0m",
  "Your limit will reset at 3:00 PM.",
].join("\n");

describe("rateLimitRecognizer", () => {
  it("kind is 'rate_limited'", () => expect(rateLimitRecognizer.kind).toBe("rate_limited"));
  it("detects a usage/rate limit and extracts the reset hint", () => {
    const out = rateLimitRecognizer.match(LIMIT, "");
    expect(out?.data.message).toMatch(/usage limit reached/i);
    expect(out?.data.resetsAt).toMatch(/3:00 PM/);
    expect(out?.suggestedKeys).toEqual([]);
  });
  it("returns null on normal output", () => {
    expect(rateLimitRecognizer.match("● done\n$ ", "")).toBeNull();
  });
});
```

- [ ] **Step 2:** Run `bun test packages/core/src/recognizers/rate-limit.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `rate-limit.ts`: strip ANSI/OSC (reuse the pattern from `claude-permission.ts`);
  match `/usage limit reached|rate limit|you('| a)?re out of|limit will reset|too many requests/i`; capture
  the reset-time phrase (`/reset(?:s)?(?: at)?\s+([^\n.]+)/i`) into `resetsAt`; `data.message` = the matched
  line; `suggestedKeys: []`. Return null otherwise. Add the version-fragile warning comment.
- [ ] **Step 4:** Run the test → PASS. Then register in `manager.ts` (`pipeline.register(rateLimitRecognizer)`
  next to the others) and export from `index.ts`.
- [ ] **Step 5:** `turbo run typecheck lint test` green; commit `feat(core): rate-limit recognizer`.

### Task 5: session recovery (re-adopt on restart)
**Files:** Modify `packages/core/src/manager.ts` (add `recover()`), `manager.test.ts`.

**Interfaces:** Produces `SessionManager.recover(): Promise<SessionInfo[]>` — lists existing sessions via
`env.listSessions()` for the default env and re-registers any not already tracked (id = name), returning the
adopted infos. Idempotent.

- [ ] **Step 1: Write the failing test** (`manager.test.ts`, new describe): a fake env whose `listSessions`
  returns `["tb-x","tb-y"]`; `manager.recover()` registers both; `manager.list()` has 2; a second `recover()`
  adopts nothing new (idempotent); a tracked session is not duplicated.
- [ ] **Step 2:** Run it → FAIL (no `recover`).
- [ ] **Step 3: Implement** `recover()`: build the default-kind env via the factory; `const names = await
  env.listSessions()`; for each name not in the registry, create a Session (observer via `observerFactory`
  on the pipe file, pipeline with all recognizers, fresh WriteLock) and register `{id:name,name,env:kind,
  state:"running"}`; skip names already tracked; respect the concurrency cap; return the adopted infos.
- [ ] **Step 4:** Test → PASS. `turbo run test lint typecheck` green.
- [ ] **Step 5:** Commit `feat(core): SessionManager.recover() re-adopts existing sessions`.

### Task 6: creds-refresh verification
- [ ] **Step 1:** In Docker, after the existing login, run a session, let claude run long enough to refresh,
  then confirm a fresh container still reuses creds (no `needs_login`). Document the result + the re-login
  path in `docs/integration/README.md` (auth section). If refresh does NOT persist to the volume, file a
  follow-up note (don't fix here). Commit the doc.

---

## D3 — Docker image distribution

### Task 7: versioned reference image + run docs
**Files:** Modify `README.md` / `docs/integration/README.md`.

- [ ] **Step 1:** Tag the built image `termbridge:0.1.0` and `termbridge:latest` (local). Document
  `docker run` usage for a consumer (mount creds volume + repo, run the stdio server or a session).
- [ ] **Step 2 (gated):** Push to a registry (GHCR/Docker Hub) — **requires operator `docker login`**;
  document the pull command once pushed. Do not push without approval.
- [ ] **Step 3:** Commit the docs.

---

## D4 — npm publish (gated)

### Task 8: packaging for npm
**Files:** Modify `packages/mcp-server/package.json`, `packages/core/package.json` (+ `packages/server`),
root.

- [ ] **Step 1:** Add to each publishable package: `"publishConfig": { "access": "public" }`, `"files":
  ["dist","README.md"]`, `"main"/"types"/"exports"` pointing at `dist`, a `"build": "tsc"` that emits `dist`,
  and `bin` → `dist/stdio.js` for mcp-server. Remove `"private": true` only on packages to be published.
- [ ] **Step 2:** `bun run build` (tsc → dist) for core + mcp-server; verify `dist` has `.js` + `.d.ts`.
- [ ] **Step 3:** `npm pack` (dry) each package; in a temp dir `npx ./<tarball>` smoke the stdio server
  responds to an MCP `list_tools`. Fix packaging until clean.
- [ ] **Step 4 (gated):** `npm publish` each — **requires operator approval + npm auth + confirmed
  `@termbridge` scope ownership.** Do not publish otherwise. Commit packaging changes regardless.

---

## Verification (whole plan)
- `turbo run test lint typecheck` green after D2.
- D1: stdio MCP live-verified consumable by a real claude (transcript in docs); example driver runs.
- D2: rate-limit recognizer + recovery unit-tested; creds-refresh checked in Docker.
- D3/D4: image tagged + `npm pack`/`npx` tarball smoke green; registry push + npm publish gated on approval.

## Self-review notes
- Spec coverage: §3 contract → D1; §4 distribution → D1/D3/D4; §5 hardening → D2; §2 boundary → Global
  Constraints (no evasion) + the gated publishes. ✓
- No placeholders: rate-limit + recover have concrete tests/impl; docs tasks name exact files.
