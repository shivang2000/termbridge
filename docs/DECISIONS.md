# termbridge — Decisions (ADRs)

Short architecture decision records. Status: **accepted** unless noted.

---

## D1 — tmux as the human↔agent sharing substrate
**Decision:** Share one session by running it inside a **named tmux session**; the agent drives via tmux
CLI (`send-keys`/`capture-pane`) and never attaches, while the human attaches through the web bridge.

**Why:** Deep research found no purpose-built multiplexing protocol in the wild; the verified, repeatable
pattern is tmux co-presence (tmux-mcp, GoTTY's tmux workaround). tmux gives session persistence,
reconnect, and multi-client attach for free.

**Rejected:** Single-PTY broadcast (fan one PTY's stdout to web + agent) — simplest but no native
persistence and contention is fully manual. Bespoke arbitration protocol — no prior art, high effort.

**Consequences:** tmux must exist in every environment image/host. Window-size arbitration between two
attached clients needs care (pin size / `aggressive-resize`).

---

## D2 — Brand-new standalone repo
**Decision:** Build in a fresh repo (this one), not inside `sentry-fixer-bot` or `paperclip`.

**Why:** The component should be reusable by *both* existing products and external agents. A standalone
repo avoids coupling to either stack and keeps the surface clean.

**Rejected:** Extend `sentry-fixer-bot` (fastest demo, but couples to alertforge). Build inside `paperclip`
(max infra leverage, but ties to paperclip's model).

**Consequences:** We port (not import) code from both repos — see ARCHITECTURE.md reuse map.

---

## D3 — Core library + MCP server first; Claude Code plugin later
**Decision:** Build the framework-agnostic `core` library, then the **MCP server** as the primary
agent-facing interface. Defer the Claude Code plugin/skill (with wake-on-terminal-event).

**Why:** MCP is the lingua franca — one server reaches Claude Code, Cursor, Codex, and Hermes-if-MCP. A
plugin is just MCP + a manifest; a library-only approach forces every integrator to re-glue. Building
`core` first hedges the case where Hermes needs a native (non-MCP) binding.

**Rejected:** MCP + plugin together in pass 1 (more upfront work, Claude-only benefit). Library-first
(only if Hermes can't speak MCP).

**Consequences:** Wake-on-event ergonomics (pi-interactive-shell `triggerTurn` style) arrive in M6, not v1.

---

## D4 — Local **and** Docker backends, user-selectable; cloud sandbox later
**Decision:** Ship **both** `LocalEnvironment` and `DockerEnvironment` as first-class, **user-selectable at
runtime** (via MCP `open_session` `env` arg and web UI). Cloud-sandbox backends (E2B/Daytona/Cloudflare)
plug into the same `TerminalEnvironment` interface later (M6).

**Why (user choice):** Local = fastest, zero-ops, best for trusted/dev. Docker = strong self-hosted
isolation for untrusted agents. Letting the user pick avoids forcing one trade-off; the pluggable
interface makes adding cloud sandboxes a port, not a rewrite.

**Rejected:** Cloud-sandbox as the default (cost, cold-start, data egress, third-party dependency for v1).
Local-only (unsafe for untrusted agents). Docker-only (loses the zero-ops dev path).

**Consequences & guardrail:** When `env: "local"` is selected, the UI/MCP must **surface explicitly that
there is no isolation** (agent = full host access). Research is clear that blocklists don't substitute for
isolation, so untrusted/multi-tenant use must be steered to Docker (or cloud sandbox later).

---

## Defaults chosen by the assistant (open to change)
- **Repo/product name:** `termbridge` (placeholder).
- **GitHub:** pushed to `shivang2000`, **private** visibility (flip to public anytime).
- **Default `env`:** server-configurable; recommend `docker` for untrusted, `local` for dev.
