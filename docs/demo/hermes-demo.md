# termbridge × Hermes — live demo runbook

The pitch (say this first): *"I drop a ticket in chat. An agent opens Claude Code on my subscription, does
the work in our repo, runs the tests, and opens a PR — and I watch the whole thing stream back in the
channel. No metered API."*

This runbook covers **(1) setting up termbridge in Hermes** and **(2) running a live implementation**.
Hermes itself is assumed installed. Demo uses **local mode** (claude runs on the presenter's laptop, uses
your existing `git`/`gh`) — simplest + most reliable on stage. Docker mode notes at the end.

---

## Pre-flight checklist (do this ~10 min before)

- [ ] **claude logged in** (subscription) into the creds volume. One-time:
  ```bash
  mkdir -p ~/.termbridge/home
  docker run --rm -it -v ~/.termbridge/home:/creds -e HOME=/creds shivang2000/termbridge-sandbox:latest claude
  # pick "Claude account with subscription", open the URL, paste the code
  ```
  (Local mode reads creds from `~/.termbridge/home`; this populates it once.)
- [ ] **host `gh` authed**: `gh auth status` → logged in (this opens the PR).
- [ ] **target repo cloned locally** (you have access): `git clone <repo> ~/dev/portal`
- [ ] **a small, fast ticket** picked, and a **quick verify command** (lint / build / one test file — NOT the
      whole UI suite). Know the answer so the demo is predictable.
- [ ] **default tmux is safe** — termbridge only uses `tmux -L termbridge`; your real tmux is never touched.

---

## 1. Set up termbridge in Hermes (one-time)

```bash
# MCP server — no clone, runs from npm:
hermes mcp add termbridge \
  --env TERMBRIDGE_HOME="$HOME/.termbridge/home" TERMBRIDGE_TMUX_SOCKET=termbridge \
        TERMBRIDGE_ALLOWED_ENVS=local,docker TERMBRIDGE_MAX_SESSIONS=2 \
  --command npx --args -y @termbridge/mcp-server

# the engineer-loop skill (from the public repo):
hermes skills install \
  https://raw.githubusercontent.com/shivang2000/termbridge/main/skills/engineer-loop/SKILL.md --yes

# verify + apply:
hermes mcp test termbridge      # → ✓ Connected, 13 tools
hermes gateway restart          # ⚠️ kills running agents — do it BEFORE the demo, not during
```

> `TERMBRIDGE_ALLOWED_ENVS=local,docker` permits local mode on this trusted laptop. For a shared/untrusted
> bot use `docker` only (see the docker note below). Give Hermes a **Jira tool** if you want it to fetch the
> ticket by id; otherwise you'll paste the ticket text.

---

## 2. The live run (what you type, what the audience sees)

**You (in the channel):**
> **@bot use the engineer-loop skill (env: local). Ticket PROJ-123: `<paste title + a line of body>`.
> Repo `~/dev/portal`, work in the developer-portal-UI app. Verify with `<your verify cmd>`. Open a PR when done.**

**The beats the audience sees (~30s–few min):**
1. **"Opening a Claude Code session…"** — Hermes calls `open_session`; claude boots in `~/dev/portal`.
2. **Progress digests, ~every 25s** — one line each:
   `🔧 Read(src/…)` → `… thinking` → `✏️ Update(src/Foo.tsx)` → `🔧 Bash(<verify cmd>)`.
   (This is the live `read_progress` feed — the "watch it work" moment.)
3. **"Verified ✓"** — claude runs your command, reports pass.
4. **The PR gate** — the bot asks: *"Verified on `tb/proj-123` — open a PR?"* → **you reply "yes."**
5. **PR link posted** — committed the branch, pushed, `gh pr create` → **PR URL in the channel.** Open it;
   show the diff. Done.

**Optionally** open the browser view mid-run to show the live pane + activity bar (only if you ran a server;
not needed for the chat demo).

---

## 3. Talking points (highlight while it runs)

- **Subscription, not API** — "every token here bills against the Claude plan, shared across sessions."
- **Real repo, real PR** — "it's editing our actual code and opening a real PR — not a sandbox toy."
- **Human-in-the-loop** — "it asked me before opening the PR; I could've taken over in the browser anytime."
- **Safe** — "isolated tmux socket; for untrusted callers we pin it to a docker container."
- **Fleet** — "this is one agent; an orchestrator can run many in parallel on the one subscription."

---

## 4. If something flakes — zero-infra CLI fallback (no Hermes, no Discord)

Same loop, one terminal command — great backup if the gateway/Discord misbehaves:
```bash
cd ~/dev/termbridge   # a clone of github.com/shivang2000/termbridge (bun install once)
bun scripts/engineer.ts --repo ~/dev/portal \
  --goal "PROJ-123: <title> — <body>" --accept "<criteria>" --verify "<cmd>" --env local --pr ask
```
Edits → verifies → asks → opens the PR via your host `gh`. Progress streams to the terminal.

---

## 5. Reset between runs

```bash
gh pr close <pr#> --delete-branch        # tidy the demo PR
git -C ~/dev/portal checkout main && git -C ~/dev/portal branch -D tb/<slug> 2>/dev/null || true
tmux -L termbridge kill-server 2>/dev/null || true   # ONLY the -L termbridge socket — never your default tmux
```
> Never run `pkill -f claude` or `tmux kill-server` without `-L termbridge` — that can kill your own
> claude/tmux. Always scope cleanup to the `-L termbridge` socket.

---

## Docker mode (isolated — for the "untrusted/shared bot" framing)

Use `TERMBRIDGE_ALLOWED_ENVS=docker` and pull the sandbox image first:
```bash
docker pull shivang2000/termbridge-sandbox:latest
docker tag  shivang2000/termbridge-sandbox:latest termbridge:dev
```
Each session runs in a container with the repo bind-mounted. For the container to open the PR itself, add
`GH_TOKEN=<token>` to the termbridge MCP env (it's forwarded into the session); otherwise claude commits a
branch and you push + open the PR from the host. Everything else in the run is identical.
