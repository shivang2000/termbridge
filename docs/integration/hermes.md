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

## Install — one command (recommended)

`setup.sh` checks prereqs + versions, pulls the sandbox image (resolving the **current** version from npm,
so it never goes stale) and smoke-tests it, logs you in to Claude **inline** (works even via `curl | bash`),
registers the MCP server + the `engineer-loop` skill in Hermes, and verifies with `hermes mcp test`.
Idempotent — safe to re-run. **No `git clone` anywhere** — sessions run from the Docker Hub image, the MCP
server from `npx`, the skill from a raw URL.

```bash
curl -fsSL https://raw.githubusercontent.com/shivang2000/termbridge/main/scripts/setup.sh | bash
```

Common variations:
```bash
# trusted laptop, host-native (claude + Jira MCP + gh from your real ~/.claude / host):
curl -fsSL …/scripts/setup.sh | bash -s -- --mode local --api-key sk-ant-… --gh-token ghp_…
# isolated docker container per session:
curl -fsSL …/scripts/setup.sh | bash -s -- --mode docker
# + browser watch (localhost URL to watch/intervene; needs bun on the host):
curl -fsSL …/scripts/setup.sh | bash -s -- --mode local --api-key sk-ant-… --gh-token ghp_… --watch
```
**On macOS, local mode needs the two tokens** (`--api-key`, `--gh-token`): Claude's subscription login and
`gh`'s tokens live in the **Keychain**, which a gateway-spawned process can't read — so pass tokens that
bypass it. The PAT needs `repo` + `workflow` scope (SSO-authorized for the org).
It will **not** restart your gateway unless you pass `--restart` (a restart kills running agents). When it
finishes it prints the exact `hermes gateway restart` to run when idle. `--help` lists every flag.

When it finishes, `setup.sh` prints an **Authentication summary** telling you exactly what's logged in and
what's still missing. You authenticate three things (termbridge itself never logs in to GitHub/Jira — it
pilots Claude; the host/agent own those):

| What | Why | How |
|---|---|---|
| **Claude** | required — Claude must be authenticated in the session | **local (macOS):** `--api-key sk-ant-…` (the Keychain login isn't readable by a gateway-spawned claude). **docker:** the file-creds volume (`setup.sh` runs the one-time login). |
| **GitHub** | to open the PR **in-session** | `--gh-token ghp_…` (PAT, `repo`+`workflow`, SSO-authorized) — forwarded into the session. Local mode also auto-forwards `gh auth token`, but a PAT is the reliable path past the Keychain + multi-account mess. |
| **Jira / tracker** | optional | **the driven Claude fetches the ticket via its own Jira MCP** (local mode = your real `~/.claude`, so your MCPs load). Hermes itself needs no Jira tool. |

### Watch in the browser

`setup.sh --watch` (local mode) starts `bunx @termbridge/server` on the host and registers the MCP to
proxy to it (`TERMBRIDGE_SERVER_URL` + `TERMBRIDGE_TOKEN`), so the web bridge and the agent share one
session registry. It prints a `http://127.0.0.1:PORT/?token=…` URL. The `engineer-loop` skill then posts
the per-session `?session=<id>&token=…` URL in chat — open it to watch the live pane + activity bar;
**type to take over** (the in-session auto-approver pauses while you drive). Loopback + token; local mode
only.

Then jump to [Use it](#use-it-in-chat). The manual steps below are what the script automates.

---

## Install — manual (one-time)

**Prereqs on the host:** `node` ≥ 20 (for `npx`) or `bun`, `docker`, a Claude subscription. No clone
needed — the MCP server comes from npm and the session sandbox from Docker Hub.

### 1. Get the per-session sandbox image (no clone needed)
Each session runs `claude` inside this image; tag it as the default `termbridge:dev`:
```bash
docker pull shivang2000/termbridge-sandbox:1.0.7
docker tag  shivang2000/termbridge-sandbox:1.0.7 termbridge:dev
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
- **Published on npm:** `@termbridge/core`, `@termbridge/mcp-server`, `@termbridge/orchestrator`,
  `@termbridge/server`, `@termbridge/sandbox-e2b` (latest: 1.0.7). The MCP server runs via
  `npx -y @termbridge/mcp-server` (no clone).
  To build your own loop, depend on `@termbridge/orchestrator`. Browser watch: `bunx @termbridge/server`
  (or `setup.sh --watch`).
- **Safety/limits:** keep `TERMBRIDGE_ALLOWED_ENVS=docker` and a low `TERMBRIDGE_MAX_SESSIONS`.
  Auto-approval presses through every prompt inside the container — the container is the isolation. Fleet
  use of a subscription may hit plan limits / terms; cap concurrency. Watch utilization via the web UI
  session list or `GET /api/sessions` on the unified server (`count`/`maxSessions`, per-session
  `idle`|`driving`|`human-takeover`). On `rate_limited` events, back off — do not open more sessions.
