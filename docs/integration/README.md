# Integrating termbridge into an agent

termbridge lets an MCP-capable agent **spawn and pilot a real `claude` TUI** (or any interactive CLI) over
a shared tmux session, so the agent runs work on a **Claude subscription** instead of metered API.

> ⚠️ **Usage terms.** Automating a consumer Claude subscription likely violates Anthropic's terms and can
> get the account banned (it's why `claude -p` / API-on-subscription is restricted). termbridge ships only
> good-citizen controls (concurrency cap, rate-limit backoff, fail-clean on logout) and **no
> detection-evasion**. You own the terms decision for whatever subscription you point it at.

## The contract: MCP over stdio

Every MCP-capable agent integrates the same way — a stdio command:

```
bun /ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts
# after npm publish (D4):  npx -y @termbridge/mcp-server
```

Environment:

| Var | Meaning | Default |
|---|---|---|
| `TERMBRIDGE_HOME` | shared credentials volume (each session's `HOME`) — where the one `claude` login lives | unset → ambient HOME |
| `TERMBRIDGE_TMUX_SOCKET` | dedicated tmux socket (`-L`) so host tmux is never touched | `termbridge` |
| `TERMBRIDGE_MAX_SESSIONS` | concurrency cap (respect plan limits) | `4` |
| `TERMBRIDGE_PIPE_DIR` | per-session pipe-pane dir (must be Docker-mountable for `env:"docker"`) | a mkdtemp dir |

One-time login (creds then reused by every session — see the auth section below).

## Tool surface (§6 — 13 tools)

| Tool | Args | Returns |
|---|---|---|
| `open_session` | `{name?, env?: "local"\|"docker"\|"sandbox", cwd?, repo?, branch?, cmd?, cols?, rows?}` | `{id,name,env}` |
| `list_sessions` | `{}` | `{sessions:[{id,name,env,state}]}` |
| `send_text` | `{id,text,enter?=true}` | `{ok}` or `{ok:false,error:"human_driving"}` |
| `send_control` | `{id,key}` (`C-c`,`Escape`,`Up`,`Enter`…) | `{ok}` |
| `read_screen` | `{id,scrollback?}` | `{screen}` |
| `read_new_output` | `{id,sinceOffset?}` | `{data,nextOffset}` |
| `wait_for_idle` | `{id,quietMs=400,timeoutMs=30000}` | `{idle,waitedMs}` |
| `wait_for_text` | `{id,pattern,timeoutMs=30000}` | `{matched,screen}` |
| `read_events` | `{id,sinceOffset?}` | `{events:[{kind,data,suggestedKeys}],nextOffset}` |
| `wait_for_event` | `{id,kinds?,timeoutMs?}` | `{events,timedOut,nextOffset}` |
| `resize` | `{id,cols,rows}` | `{ok}` |
| `close_session` | `{id}` | `{ok}` |

Recognizer event `kind`s an agent should handle: `oauth-url`, `needs_login`, `claude-permission`,
`generic-yn`, `rate_limited`, `human_took_over`.

**Canonical loop:** `open_session` → `send_text` (the task) → `wait_for_idle`/`wait_for_text` →
`read_events` (answer prompts via `send_text`/`send_control` using `suggestedKeys`) → `read_screen`. See
[`examples/drive-claude.ts`](../../examples/drive-claude.ts).

## Auth (subscription, shared)

1. Point `TERMBRIDGE_HOME` at a persistent dir (e.g. `~/.termbridge/home`).
2. One-time login (run in Docker — macOS stores the token in Keychain, so file-based creds only persist on
   Linux/Docker): `docker run -it --rm -v ~/.termbridge/home:/creds -e HOME=/creds termbridge:dev claude`
   → choose "Claude account with subscription", open the printed URL, paste the code.
3. Every session with that `TERMBRIDGE_HOME` reuses the login (no re-auth). A logged-out volume surfaces a
   `needs_login` event; `claude`'s login URL surfaces as an `oauth-url` event.

## Distribution (private / internal)

termbridge is kept **private** — not on public npm or a public registry. Consumers install via:

- **From source:** `git clone … && bun install`, then point the agent at
  `bun /ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts` (see per-agent guides).
- **Local Docker image:** `docker build -t termbridge:0.1.0 -f docker/Dockerfile .` (bun + tmux + node +
  claude + git); run sessions / the stdio server inside it.

To share with your team later **via a private registry** (no public exposure):
- Docker: `docker login <your-registry>` → `docker tag termbridge:0.1.0 <your-registry>/termbridge:0.1.0`
  → `docker push <your-registry>/termbridge:0.1.0`.
- npm: remove `"private": true` from `packages/{core,mcp-server}/package.json`, `bun run build`, then
  `bun publish --registry <your-private-registry>` (publishConfig already targets `dist`; `workspace:*`
  resolves at publish). **Do not publish to public npm.**

Per-agent guides: [claude](./claude.md) · [paperclip](./paperclip.md) · [hermes](./hermes.md) ·
[opencode](./opencode.md).
