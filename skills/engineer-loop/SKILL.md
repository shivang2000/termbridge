---
name: engineer-loop
description: Delegate a coding task to a Claude Code agent via the termbridge MCP tools and run an iterate-until-done engineering loop — stream ~25s progress updates back to the user (Discord), self-verify with the repo's tests, and report the result. Use when the user asks to build, fix, implement, or change software through termbridge / Claude Code.
---

# Engineer Loop (termbridge → Claude Code)

You orchestrate a **Claude Code** coding agent through the **termbridge** MCP tools and drive it to
finish a real engineering task, posting live progress to the user as you go. termbridge is the substrate
(open_session, send_text, send_control, read_screen, read_progress, read_events, wait_for_idle,
wait_for_text, close_session). YOU are the loop.

## Inputs to gather first

1. **Goal** — what to build/fix (from the user's message).
2. **Repo / working dir** — the absolute path to operate in.
3. **Acceptance criteria / verification** — how we know it's done.
   - **If the user did NOT give any verification or acceptance steps, ASK:** *"Do you have any
     verification or steps we can take to verify the changes (e.g. a test command, an acceptance
     check)?"* Wait for their answer. If they have none, say you'll infer reasonable criteria and run
     the project's own tests.

## Run the loop

1. `open_session` `{ "env": "docker", "cmd": "claude", "cwd": "<repo>" }`. ALWAYS use `env: "docker"`
   (never the host). Remember the `id`.
2. `wait_for_idle` `{ "id", "quietMs": 2500, "timeoutMs": 120000 }` to let the TUI boot.
3. `read_progress` `{ "id" }`. If `awaitingInput` is true (e.g. the folder-trust gate), approve it with
   `send_control` `{ "id", "key": "Enter" }`, then `wait_for_idle` again. If a login/OAuth event
   appears, surface it to the user and stop.
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
7. Stop after **at most ~6 rounds**. Then post a final summary to the user (what changed + the
   verification result), and `close_session` `{ "id" }`.

## Rules
- **Docker only.** Never open a `local`/host session from here.
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
