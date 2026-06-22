---
name: engineer-loop
description: Take a coding task — often a Jira/tracker ticket reference (e.g. PROJ-123) dropped in chat — and run it to done by piloting a Claude Code agent through the termbridge MCP tools: open a session with a sharp engineering prompt, auto-approve routine reads/edits, self-verify with the repo's tests, and stream ~25s progress + the final review back to the user's channel. Use when the user asks to build, fix, implement, or ship a ticket/change through termbridge / Claude Code.
---

# Engineer Loop (termbridge → Claude Code)

You orchestrate a **Claude Code** coding agent through the **termbridge** MCP tools and drive it to
finish a real engineering task, posting live progress to the user as you go. termbridge is the substrate
(open_session, send_text, send_control, read_screen, read_progress, read_events, wait_for_idle,
wait_for_text, close_session). YOU are the loop.

## Inputs to gather first

0. **Ticket reference?** If the message names a tracker ticket (e.g. `PROJ-123`, a Jira/Linear URL) and you
   have a tracker tool/MCP, **fetch it** and use its title + description as the goal and its acceptance
   criteria as the acceptance list. No tracker tool? Ask the user to paste the ticket text.
1. **Goal** — what to build/fix (from the ticket or the user's message).
2. **Repo / working dir** — the absolute path to operate in.
3. **Acceptance criteria / verification** — how we know it's done.
   - **If the user did NOT give any verification or acceptance steps, ASK:** *"Do you have any
     verification or steps we can take to verify the changes (e.g. a test command, an acceptance
     check)?"* Wait for their answer. If they have none, say you'll infer reasonable criteria and run
     the project's own tests.

## Run the loop

1. `open_session` `{ "env": <as requested>, "cmd": "claude", "cwd": "<repo>" }`. Use the env the
   operator/user specifies — `"docker"` by default (isolated), `"local"` when they ask (claude runs on the
   host's `-L termbridge` tmux; the user's default tmux is never touched). Remember the `id`.
2. `wait_for_idle` `{ "id", "quietMs": 2500, "timeoutMs": 120000 }` to let the TUI boot.
3. `read_progress` `{ "id" }` (and `read_screen` if unsure). Clear the two boot gates yourself:
   - **Folder-trust** (`awaitingInput`, "Do you trust…"): approve with `send_control` `{ "id", "key": "Enter" }`,
     then `wait_for_idle`.
   - **Not logged in** ("Not logged in · Run /login", or a `needs_login` event): AUTO-DRIVE the login — do
     NOT make the user run it step by step. (If the session was started with an API key this won't appear.)
     a. `send_text` `{ "id", "text": "/login", "enter": true }`; `wait_for_idle`.
     b. `read_screen`; at the method menu pick **subscription**: `send_text` `{ "id", "text": "1", "enter": true }`.
     c. `wait_for_event` `{ "id", "kinds": ["oauth-url"], "timeoutMs": 60000 }` (or `read_screen`) to get the
        authorize URL. **Post it to the channel ONCE:** *"Click to authorize, then I'll continue."*
     d. Poll `wait_for_idle` / `read_screen` until the login card clears / "Logged in" appears (the user
        finished in the browser); press `Enter` if a "press enter to continue" remains.
     e. `read_screen` to confirm a clean, empty prompt — login often clears the input line, so the task must
        be sent fresh in step 4.
   The user's ONLY action is the single browser click; never ask them to type `/login` or pick the option.
4. Send the task with `send_text` `{ "id", "enter": true, "text": <engineering prompt> }`. The prompt MUST:
   - State the goal and the acceptance criteria.
   - Tell claude to verify by running the repo's tests (or the user's command).
   - Instruct: *"When (and only when) every criterion holds AND verification passes, print a line that
     STARTS with the marker, nothing before it: `TB_LOOP_DONE: PASS`. If it cannot be done, print a
     line starting with `TB_LOOP_DONE: FAIL <reason>`. Do not print the marker until you have actually
     run the verification."*
5. **Pump the turn** (repeat): call `wait_for_idle` `{ "id", "quietMs": 4000, "timeoutMs": 25000 }`,
   then `read_progress` `{ "id", "sinceOffset": <last nextOffset> }`.
   - **Post a short digest to the user** each tick: the `phase` + tool/file + the last meaningful line
     (e.g. *"🔧 Write(notes.txt)"*, *"… thinking"*, *"running bun test"*). Keep it to one line.
   - If `awaitingInput` is true (claude is asking to make an edit / run a command), **approve it**:
     `send_control` `{ "id", "key": "Enter" }`.
   - When `wait_for_idle` reports `idle: true`, the turn is done — go to step 6.
6. `read_screen` `{ "id", "scrollback": 200 }`. If it contains a line `TB_LOOP_DONE: PASS` → **done,
   success**. If `TB_LOOP_DONE: FAIL <reason>` → note the reason. Otherwise send a corrective nudge with
   `send_text` ("You haven't printed the completion marker; finish, run the verification, then print
   `TB_LOOP_DONE: PASS`") and repeat from step 5.
7. **Deliver (after PASS).** Create a git branch `tb/<slug>` and commit the changes (set
   `git config user.email/name` if git complains). Then **ASK the user in chat: "Verified on `tb/<slug>` —
   open a PR?"**
   - On **yes**: if the session has `gh` authenticated (a `GH_TOKEN` was forwarded), run `gh auth setup-git`,
     push, and `gh pr create --fill --head tb/<slug>` (ready-for-review). Otherwise the branch is committed —
     push it + `gh pr create` yourself on the host (you have `gh`). Post the PR link back to the channel.
   - If the user does NOT answer (or you cannot ask): open it as a **draft** (`--draft`). Never silently skip.
8. Stop after **at most ~6 rounds**. Post a final summary (what changed + verification + PR link), then
   `close_session` `{ "id" }`.

## Rules
- **Mode.** Default to `env: "docker"` for untrusted/shared chat (isolated container). On a trusted
  single-user machine the operator may allow `env: "local"` — claude then runs on the host's tmux
  `-L termbridge` socket (the user's **default tmux is never touched**) and uses the host's git/gh directly,
  which is the simplest path (no bind-mount, no token). Use whichever the deployment permits.
- **Approve to keep moving.** Auto-approve claude's edit/command permission prompts (Enter) — that is
  the point of the autonomous loop. (The sandbox is the container.)
- **Cadence.** Aim for a progress update every ~25s. You act in turns, so use the `wait_for_idle`
  timeout as your pacing.
- **Round-complete = wait_for_idle**, not "no new output". A quiet gap is not "done"; only the
  `TB_LOOP_DONE` marker is.
- **Be honest** about the result. If acceptance wasn't met in the round budget, say so and offer to
  continue.

This skill is the prompt-level twin of `@termbridge/orchestrator`'s `runEngineerLoop`; if you have a
code runtime, that package implements the same loop deterministically.
