# termbridge × Hermes — install & use (chat a ticket → Claude Code ships it)

The headline flow: you drop a ticket in your channel, Hermes opens **Claude Code** through termbridge with
a sharp engineering prompt, auto-approves the routine edits, runs your tests, and streams progress + the
final review back to the channel — all on your Claude **subscription**.

```
You ─ "@bot ship PROJ-123" ─▶ Hermes ──(termbridge MCP)──▶ claude (docker, subscription) edits your repo
                                  ▲                                  │ auto-approve · run tests · iterate
                                  └──── ~25s progress + review ──────┘   (back in your channel)
```

Hermes does the orchestration (fetch the ticket, run the loop); termbridge is the substrate that pilots
Claude. This works with any MCP-capable agent — Hermes is the worked example.

---

## Install (one-time)

**Prereqs on the host:** `node` ≥ 20 (for `npx`) or `bun`, `docker`, a Claude subscription. No clone
needed — the MCP server comes from npm and the session sandbox from Docker Hub.

### 1. Get the per-session sandbox image (no clone needed)
Each session runs `claude` inside this image; tag it as the default `termbridge:dev`:
```bash
docker pull shivang2000/termbridge-sandbox:1.0.2
docker tag  shivang2000/termbridge-sandbox:1.0.2 termbridge:dev
```

### 2. Log in to Claude once (creds persist + are shared by every session)
```bash
mkdir -p ~/.termbridge/home
docker run --rm -it -v ~/.termbridge/home:/creds -e HOME=/creds termbridge:dev claude
# pick "Claude account with subscription", open the URL, paste the code. Done forever.
```

### 3. Register the MCP server in Hermes — pinned to docker (untrusted chat caller)
```bash
hermes mcp add termbridge \
  --env TERMBRIDGE_HOME="$HOME/.termbridge/home" TERMBRIDGE_TMUX_SOCKET=termbridge \
        TERMBRIDGE_ALLOWED_ENVS=docker TERMBRIDGE_MAX_SESSIONS=3 \
  --command npx \
  --args -y @termbridge/mcp-server
```
`TERMBRIDGE_ALLOWED_ENVS=docker` means a chat-triggered session can **never** run on the host — only in a
container. (Equivalent manual edit: add the same block under `mcp_servers:` in `~/.hermes/config.yaml`.)

### 4. Install the engineer-loop skill (from the public repo)
```bash
hermes skills install \
  https://raw.githubusercontent.com/shivang2000/termbridge/main/skills/engineer-loop/SKILL.md --yes
```

### 5. (Optional) give Hermes a Jira/tracker tool
So it can fetch a ticket by reference (`PROJ-123`). Without one, paste the ticket text in chat — the skill
uses that. termbridge does not pull from Jira; that's the agent's tool.

### 6. Verify + apply
```bash
hermes mcp test termbridge        # → ✓ Connected, 13 tools
hermes gateway restart            # picks up the MCP env + the skill (restart kills running agents)
```

---

## Use it (in chat)

Mention the bot with the ticket and the repo to work in:

> **@bot use the engineer-loop skill: ship PROJ-123 in `/work`. verify with `npm test`.**

Hermes will: fetch/parse the ticket → `open_session` (docker, bound to the repo) → send claude the goal +
acceptance → **auto-approve** its edit/command prompts → run your tests each round → post a one-line digest
every ~25s → finish with a summary + the diff, or ask for verification steps if you gave none. You can open
the live browser view (the unified server) and **type to take over** at any point.

> Make sure the repo you name is reachable by the session. Mount/checkout it where the container can see it,
> or run the unified server with the repo bind-mounted (see the main [README](../../README.md)).

---

## Notes

- **13-tool surface** (see the [README](../../README.md)). The low-level driving contract (open → send →
  `wait_for_event` for `claude-permission` → answer → read) is in
  [`examples/drive-claude.ts`](../../examples/drive-claude.ts); handle `needs_login`, `rate_limited`,
  `human_took_over`.
- **The same loop without a clone / without chat:** `@termbridge/orchestrator`'s `runEngineerLoop`, or the
  CLI `scripts/engineer.ts` against a running server — see the README "Walkthrough".
- **Published on npm:** `@termbridge/core`, `@termbridge/mcp-server`, `@termbridge/orchestrator` (≥ 1.0.2).
  The MCP server runs via `npx -y @termbridge/mcp-server` (no clone). To build your own loop, depend on
  `@termbridge/orchestrator`.
- **Safety/limits:** keep `TERMBRIDGE_ALLOWED_ENVS=docker` and a low `TERMBRIDGE_MAX_SESSIONS`.
  Auto-approval presses through every prompt inside the container — the container is the isolation. Fleet
  use of a subscription may hit plan limits / terms; cap concurrency.
