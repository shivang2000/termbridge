# Hermes prompt — fix a Jira ticket via termbridge (ticket → Claude → PR)

Paste one of these to your Hermes work-agent **after**
`setup.sh --mode local --api-key … --gh-token … --watch` + `hermes gateway restart`.

Hermes opens a termbridge session running your host `claude`, and **Claude itself fetches the ticket via its
own Jira MCP** (Hermes does not need a Jira tool) — then plans, implements, verifies, and opens the PR.

> Local mode runs `claude` on the host with your **real HOME**, so your `claude` login *and your configured
> MCPs (Jira, GitHub, …) are available inside the session*. That's why Claude — not Hermes — fetches the ticket.
> If Jira MCP is missing in host `~/.claude`, paste the ticket body into the goal instead of "fetch via Jira".

With `--watch`, expect the bot/skill to post a per-session
`http://127.0.0.1:PORT/?session=<id>&token=…` URL — open it to watch the live TUI.

---

## Fields to replace (portable checklist)

| Field | Example |
|---|---|
| Bot handle | `@hermes-work-agent` |
| Absolute repo path | `/Users/you/dev/my-app` |
| Jira key | `TRES-5517` |
| Fast verify | `npm run lint && npm run typecheck` |
| Scope skips | "ignore backend point 1; frontend only" |

---

## Template (fill the < > fields)

```
@<your-bot> use the termbridge MCP + the engineer-loop skill.

Open a termbridge session — env: local, cwd: <absolute repo path> — running `claude`.

Then give Claude this goal (Claude has a Jira MCP, so let IT fetch the ticket):
"Using your Jira MCP, fetch <JIRA-KEY> and read the description. Implement ONLY the issues it
describes, in this repo. <skip instructions, e.g. ignore backend points>. When done, run
<fast verify, e.g. `npm run lint && npm run typecheck`> and fix anything it flags."

DO:
- Drive Claude through the loop: auto-approve its routine edit/permission prompts; keep iterating until
  the verify command passes.
- Post a short progress update to this channel every ~25s (read_progress).
- When verify passes, have Claude commit a branch and open a PR; post the PR link. (No need to ask me.)
- If TERMBRIDGE_SERVER_URL is set, post the browser watch URL for this session.

DO NOT:
- <points to skip>. Don't touch backend code or any other repo.
- Change unrelated files, dependencies, configs, or CI.
- Leave this repo or work outside the ticket's scope.
```

---

## Filled — TRES-5517 (frontend), auto-PR (worked example — replace the three host-specific fields)

> Host-specific: bot handle `@hermes-work-agent`, repo
> `/Users/shivang/dev/GitHub/developer-portal-ui`, ticket `TRES-5517`. Copy the template above for other machines.

```
@hermes-work-agent use the termbridge MCP + the engineer-loop skill.

Open a termbridge session — env: local, cwd: /Users/shivang/dev/GitHub/developer-portal-ui — running `claude`.

Then give Claude this goal (Claude has a Jira MCP, so let IT fetch the ticket):
"Using your Jira MCP, fetch TRES-5517 and read the description. This is a FRONTEND ticket. The FIRST point
is a BACKEND issue — IGNORE it entirely; do not touch backend code. Implement ONLY the remaining FRONTEND
fixes, inside developer-portal-ui. When done, run `npm run lint && npm run typecheck` (or the repo's fast
check — tell me what you ran) and fix anything it flags."

DO:
- Drive Claude through the loop: auto-approve its routine edit/permission prompts; keep iterating until the
  verify command passes.
- Post a short progress update to this channel every ~25s.
- When verify passes, have Claude commit a branch and open a PR (via gh); post the PR link. (No need to ask me.)

DO NOT:
- Attempt the ticket's FIRST point — it's backend, not frontend. Skip it. Don't touch backend code or any
  other repo.
- Change unrelated files, dependencies, configs, or CI.
- Leave the developer-portal-ui repo or work outside the ticket's frontend scope.
```

> Prefer the human-in-the-loop beat? Change the last DO line to:
> *"When verify passes, ASK me here before opening the PR; on my 'yes', have Claude open it and post the link."*

---

## Notes / gotchas (learned from a live run)

- **Setup flags on macOS:** use `--api-key` + `--gh-token` (and `--watch` for browser co-drive). Plain
  `setup.sh --mode local` without tokens often stalls on Keychain.
- **Local mode = your host `claude`.** It uses your real `~/.claude` — login + MCPs (Jira, etc.). If a
  session shows a login prompt, run `claude` once on the host and sign in (or pass `--api-key`).
- **Hermes has no Jira tool** in this setup — that's intentional. Claude fetches the ticket; Hermes just
  drives Claude via the termbridge tools and relays progress.
- If Claude reports *"binary missing at `~/.termbridge/home/.local/bin/claude`"*, your MCP was registered
  with `TERMBRIDGE_HOME` (the docker creds volume) which breaks local mode. Re-run
  `setup.sh --mode local` (it registers local **without** `TERMBRIDGE_HOME`), then `hermes gateway restart`.
