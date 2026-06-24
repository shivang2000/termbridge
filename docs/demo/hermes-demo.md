# termbridge × Hermes — live demo runbook (proven)

The pitch: *"I drop a Jira ticket in chat. An agent opens Claude Code in our repo, **plans** the change,
implements it, runs the tests, and opens a **PR** — streamed live in the channel."*

Proven end-to-end on **local mode** (Claude runs on the presenter's laptop with their real `~/.claude` →
their login + MCPs like Jira, host `git`/`gh`). Docker mode notes at the end.

> **Run everything on the machine that has the Hermes gateway + the target repo.** `setup.sh`, `hermes …`,
> and the repo all live there. (Each machine has its own `~/.hermes`; the skill is a local copy.)

---

## Pre-flight (one-time, ~5 min) — two tokens beat the macOS Keychain

Why tokens: on macOS, Claude's subscription login and `gh`'s tokens live in the **login Keychain**. Your
interactive terminal can read them, but a **gateway-spawned** Claude/gh (Hermes → tmux) **cannot** → "Not
logged in" / "gh auth invalid". Passing tokens via env sidesteps the Keychain entirely.

- [ ] **Anthropic API key** → console.anthropic.com → `sk-ant-…` (Claude auth; no login dance).
- [ ] **GitHub PAT** → github.com/settings/tokens → *classic* → scopes **`repo`** + **`workflow`** →
      **Authorize SSO** for the org → `ghp_…` (opens the PR in-session).
- [ ] **Target repo cloned** at a known path, deps installed (`npm install`).
- [ ] **A small, fast ticket** + a **fast verify** (lint / typecheck / one test file — not the whole suite).
- [ ] **Default tmux is safe** — termbridge only uses `tmux -L termbridge`; your real tmux is never touched.

---

## 1. Set up — one command (also installs the latest skill)

```bash
curl -fsSL https://raw.githubusercontent.com/shivang2000/termbridge/main/scripts/setup.sh \
  | bash -s -- --mode local --api-key sk-ant-YOURKEY --gh-token ghp_YOURPAT --watch
```
The recap should show `auth: ANTHROPIC_API_KEY …` and `✓ gh token forwarded — in-session PRs`. Then apply
(a restart **kills running agents**, so do it now while idle):
```bash
hermes gateway restart
```
> `setup.sh` is idempotent — re-running re-registers cleanly. `--mode local` = host-native (no Keychain,
> no docker image, no creds volume); it forwards the API key + your gh token into each session. `--help`
> lists flags. The skill install is included — no separate step.

---

## 2. The live run

**Paste to the bot:**
```
@hermes-work-agent use the termbridge MCP + the engineer-loop skill.
Open a termbridge session — env: local, cwd: <ABS REPO PATH> — running claude.
Then give Claude this goal (Claude has a Jira MCP, so let IT fetch the ticket):
"Using your Jira MCP, fetch <TICKET> and read it. <scope: frontend-only, ignore backend point N, etc.>
Implement ONLY those changes in <repo>. When done, run <fast verify> and fix anything it flags."
DO: approve the plan once (auto-accept); iterate until verify passes; ~25s progress updates;
    when verify passes, commit a branch and open a PR in-session via gh; post the link. (No need to ask.)
DO NOT: touch out-of-scope/backend code, other repos, unrelated files/deps/CI.
```
(Full template: [`docs/demo/jira-ticket-prompt.md`](jira-ticket-prompt.md).)

**Beats the audience sees:**
1. **Session opens; Claude fetches the ticket** via its Jira MCP.
2. **PLAN mode** — Claude researches read-only and **designs** the change; presents a plan. *(Great demo
   beat: "it planned before touching code.")*
3. **Bot accepts the plan with auto-accept** → Claude **executes the whole change with no per-edit prompts**.
4. **Verify** — runs lint/typecheck/tests, fixes what it flags.
5. **In-session PR** — commits a branch, `gh pr create` (using the forwarded token) → **PR link in the
   channel.** Open it, show the diff. Done.

**Watch in the browser** (with `--watch`): setup starts `bunx @termbridge/server` on the host and the bot
posts a per-session `http://127.0.0.1:PORT/?session=<id>&token=…` URL in chat — open it to watch the live
pane + activity bar; **type to take over** (the in-session auto-approver pauses while you drive). Loopback
+ token; local mode only. Without `--watch`, use `tmux -L termbridge attach -r -t <name>` as the no-server
fallback (`-r` = read-only).

---

## 3. Talking points (while it runs)

- **Plan-first** — "it designed the change before editing — I approved the plan once, then it ran autonomously."
- **Real repo, real PR** — "actual code, a real PR on our repo — not a sandbox toy."
- **Jira by Claude** — "Hermes doesn't need a Jira tool; Claude fetches the ticket with its own MCP."
- **Scoped** — "I told it to ignore the backend point — it skipped it and only did the frontend."
- **Human-in-the-loop** — "I can `tmux attach` and take over the live session anytime."
- **Fleet** — "this is one agent; an orchestrator can run many in parallel."

---

## 4. Tips / gotchas (learned live)

- **Pick a SMALL ticket.** A 1–2 file change still takes a few minutes (planning + verify). Don't demo a
  sprawling change live.
- **Both tokens or it stalls.** No `--api-key` → "Not logged in" (Keychain). No `--gh-token`/PAT → PR push
  fails "gh auth invalid" (Keychain + multi-account). The PAT must be the account with repo access (SSO-authorized).
- **gh runs IN the session**, not Hermes's host context — that's why the forwarded `GH_TOKEN` matters.
- **Finish a stuck PR** (branch committed, push blocked) from YOUR OWN terminal:
  `GH_TOKEN=ghp_… git push -u origin <branch> && GH_TOKEN=ghp_… gh pr create --base <base> --head <branch> --fill`.

---

## 5. Reset between runs

```bash
gh pr close <pr#> --delete-branch
git -C <repo> checkout <base> && git -C <repo> branch -D <branch> 2>/dev/null || true
tmux -L termbridge kill-server 2>/dev/null || true   # ONLY the -L termbridge socket — never your default tmux
```
> Never run `pkill -f claude` or `tmux kill-server` without `-L termbridge` — that can kill your own
> claude/tmux. Always scope cleanup to the `-L termbridge` socket.

---

## Docker mode (isolated — for the "untrusted/shared bot" framing)

`--mode docker` runs each session in a container (repo bind-mounted) using the shared creds volume +
`shivang2000/termbridge-sandbox` image — no host Keychain involved, so subscription login works via the
file-creds volume. Forward `GH_TOKEN`/`--gh-token` for in-container PRs. Everything else in the run is identical.
