# M5 — web: unified server (watch + intervene) — milestone plan

Authority: spec §5.3, §8, §9; D1. Master plan: M1–M6.

## Decision: no node-pty (verified)

node-pty's native fork **fails under Bun** (`posix_spawnp failed`, Bun 1.3.5). But termbridge has **tmux as
the substrate**, so the bridge needs no PTY at all — it uses tmux primitives core already wraps:
- **output** → `PtyObserver` (pipe-pane stream) + `capture-pane -e -p` for the initial paint;
- **input** → `tmux send-keys -l <raw xterm bytes>` (the proven agent path — drives arrows/Ctrl-C/codes);
- **resize** → `tmux resize-window` (live, no PTY).

So the server runs entirely on **Bun**, **in-process with the SessionManager** (so `WriteLock` works), zero
native deps. Every human keystroke routes through core → naturally flips `noteHumanActivity`. *(Deviation
from spec §5.3's "node-pty tmux attach": functionally equivalent for watch+intervene and better-arbitrated;
true attach under Node remains a later option for terminal fidelity.)*

## Unified server — `packages/server` (`@termbridge/server`, Bun + Hono)

Owns ONE `SessionManager` and exposes both interfaces over it:
- **MCP over streamable-HTTP** at `POST /mcp` — `StreamableHTTPServerTransport` + M3's `createServer({manager})`.
  The agent connects here, sharing the SessionManager + WriteLock. (M3 stdio server stays for headless.)
- **Web WS** at `/ws/:id` (`createBunWebSocket`) — per spec §8:
  - on open: send `{type:"init", screen}` from `capture-pane -e -p`; subscribe `session.onOutput` → `{type:"stdout",data}`.
  - client→server: `{type:"stdin",data}` → `session.sendHumanInput(data)` (notes human activity + send-keys -l);
    `{type:"resize",cols,rows}` → `session.resize`; `{type:"event-ack"}` optional.
  - stream `session.readEvents()` (poll) → `{type:"event", events}` (oauth-url / needs_login / claude-permission).
- **Static client** at `/` — the Vite-built xterm UI.

## Core additions (small, additive)

`packages/core/src/session/session.ts`:
- `noteHumanActivity(): void` — `this.writeLock.noteHumanActivity()`.
- `sendHumanInput(data: string): Promise<void>` — notes human activity, then `tmux send-keys -l <data>` (NOT
  write-gated — the human always wins; this is what flips the agent to `human_driving`).
- `onOutput(cb): () => void` — delegate to `observer.onData`; returns an unsubscribe.
- `readScreen({ scrollback?, escapes? })` — add `-e` when `escapes` (initial web paint keeps colours/cursor).

## Client — `packages/server/src/client/` (lean vanilla TS + Vite)

`main.ts` + `index.html`: xterm v6 (`@xterm/xterm` + addon-fit + addon-web-links); connect `/ws/:id`;
`term.onData → ws stdin`; `stdout → term.write`; `init → term.write(screen)`; `resize → ws`; render an
`EventCard` (plain DOM) for recognizer events (clickable OAuth URL + paste box → send as stdin).
*(Vanilla, not the alertforge React/shadcn components — avoids heavy UI deps; same behaviour.)*

## Verification

- Unit gate: `turbo run test lint typecheck` — core method tests (sendHumanInput argv + noteHumanActivity
  flips WriteLock; readScreen `-e`); server bridge protocol tests with a fake Session (stdin→sendHumanInput,
  resize→resize, output→stdout, events→event); Vite client build compiles.
- **M5 smoke (Docker):** start the server in the container; (a) open a session via **MCP-HTTP**; (b) connect
  a synthetic **WS** client; assert agent `send_text("echo AGENT")` AND WS `stdin("echo HUMAN\n")` both land
  in one pane (`read_screen`); (c) a WS keystroke makes the next agent `send_text` return `human_driving` +
  emit `human_took_over`; after idle, `send_text` succeeds again.

## Ship
Commit core additions / server bridge+mcp-http / client / smoke as logical units; push; continue to M6.
