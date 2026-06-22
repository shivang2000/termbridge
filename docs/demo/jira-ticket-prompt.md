# Hermes prompt — fix a Jira ticket via termbridge (ticket → Claude → PR)

Paste one of these to your Hermes work-agent **after** `setup.sh` + `hermes gateway restart`. The agent
fetches the ticket (its Atlassian/Jira tool), drives Claude Code through the termbridge MCP using the
`engineer-loop` skill, verifies, and opens the PR.

> Env: `local` runs Claude on the host (`-L termbridge` tmux, host `node_modules` + `gh`, edits in place —
> fast). `docker` is isolated but needs an in-container `npm ci` first. `setup.sh --mode local` allows **both**.

---

## Template (fill the < > fields)

```
@<your-bot> use the termbridge MCP + the engineer-loop skill to fix a Jira ticket by driving Claude Code.

TICKET: <jira-url>
Fetch it with your Atlassian/Jira tool and read the description.

REPO: <absolute repo path>     (env: local)
Open the termbridge session with this as the working directory.

VERIFY: <fast check, e.g. `npm run lint && npm run typecheck`>. The loop is DONE only when this passes.
If those scripts don't exist, infer the project's fast check and tell me what you ran.

DO:
- Work ONLY the issues described in the ticket, inside this repo.
- Auto-approve Claude's routine edit/permission prompts; keep iterating until verify passes.
- Post a short progress update to this channel every ~25s.
- When verify passes, open a PR and post the link. (No need to ask me first.)

DO NOT:
- <points to skip, e.g. "the FIRST point — it's backend, not frontend">. Don't touch backend code or other repos.
- Change unrelated files, dependencies, configs, or CI.
- Leave this repo or work outside the ticket's scope.
```

---

## Filled — TRES-5517 (frontend), auto-PR (no reply needed)

```
@hermes-work-agent use the termbridge MCP + the engineer-loop skill to fix a Jira ticket by driving Claude Code.

TICKET: https://trestleiq.atlassian.net/browse/TRES-5517
Fetch it with your Atlassian/Jira tool and read the description. This is a FRONTEND ticket.

REPO: /Users/shivang/dev/GitHub/developer-portal-ui     (env: local)
Open the termbridge session with this as the working directory.

VERIFY: run the project's lint + typecheck (e.g. `npm run lint && npm run typecheck`) after your changes.
The loop is DONE only when that passes. If those scripts don't exist, infer the repo's fast check and tell
me what you ran.

DO:
- Work ONLY the FRONTEND issues in the ticket, inside developer-portal-ui.
- Auto-approve Claude's routine edit/permission prompts; keep iterating until verify passes.
- Post a short progress update to this channel every ~25s.
- When verify passes, open a PR and post the link. (No need to ask me first.)

DO NOT:
- IGNORE THE FIRST POINT IN THE TICKET — it is a BACKEND issue, not frontend. Skip it entirely. Do not
  touch any backend code or any other repo.
- Change unrelated files, dependencies, configs, or CI.
- Leave the developer-portal-ui repo or work outside the ticket's frontend scope.
```

> Want the human-in-the-loop beat instead of auto-PR? Change the last DO line to:
> *"When verify passes, ASK me here before opening the PR; on my 'yes', open it and post the link."*
