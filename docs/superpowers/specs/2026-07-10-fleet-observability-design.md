# P2.3 — Fleet observability (design)

## Context

Operators running multi-session fleets need inventory + status at a glance.
`list_sessions` MCP/HTTP tool returns only `{ id, name, env, state }` lifecycle
fields. WriteLock holder and capacity are private.

## Decision

**Approach A — lock + capacity enrichment on a new REST endpoint.**

1. **Core (minimal public surface):**
   - `Session.lockState(): WriteLockState` — wraps private WriteLock
   - `SessionManager.capacity(): { maxSessions: number; count: number }`
2. **Server:** `GET /api/sessions` (token-gated like `/api/tool`) returns:
   ```ts
   {
     maxSessions, count,
     sessions: [{ id, name, env, state, holder, lastActivityAt, status }]
   }
   ```
   - `holder`: `"agent"` | `"human"` (maps `human-active` → `human`)
   - `status`: `human-takeover` | `driving` | `idle` (derived: human → takeover;
     agent + activity within 5s → driving; else idle)
3. **MCP `list_sessions` unchanged** (non-breaking).
4. **Client:** session list panel; poll inventory; click to `?session=&token=`.

## Rejected

- Extending `SessionInfo` / MCP `list_sessions` (would change the 13-tool contract).
- Including claude-activity phase (extra coupling; lock+activity enough for v1).

## Non-goals

- New state machines or arbitration changes.
- Real-time push of inventory (poll is fine).
