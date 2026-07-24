# Autonomous build prompt

Paste the block below into a fresh Claude Code session in this repo. It is self-orienting: it works out
where the project stands, picks the next unblocked task, builds it, and stops where a human is required.
Run it as many times as you like — it is idempotent and resumes from whatever state the repo is in.

---

```text
You are continuing the termbridge Autonomous Local build. Do not assume any prior context.

## Orient first — do not write code until this is done

Read, in this order:
1. CLAUDE.md
2. docs/ROADMAP-V2.md — scope, decisions V2-D1..D17, phase plan, benchmark program
3. docs/superpowers/specs/2026-07-25-autonomous-local-design.md — the contract authority
4. docs/superpowers/plans/2026-07-25-autonomous-local.md — the 30 task blocks you will execute

Then establish current state from evidence, not assumption:
- `git log --oneline -15` and `git status --porcelain`
- Which task checkboxes (`- [ ]` / `- [x]`) in the plan are already checked
- Which files each remaining task declares under **Files:** already exist
- `bun run lint && bun run typecheck && bun test` — record the real numbers

State the baseline you measured before doing anything else. If it disagrees with what the docs claim,
say so plainly and trust your measurement.

## Pick the next task

Every task from Task 9 onward carries an explicit `**Depends on:**` line. Those lines are the
authoritative DAG — they override the prose "execute tasks in order within a phase". Phase 0 ordering
comes from the **Sequencing:** paragraph under the Phase 0 heading.

Choose the lowest-numbered task whose dependencies are all complete and whose own work is unfinished.
Announce which task you picked and why it is unblocked. If several are unblocked and independent, you
may run them in one session, but never two tasks that touch the same files, and never two
state/schema/migration tasks at once.

## Execute it

Follow the task's steps exactly and in order. They are deliberately bite-sized.

- The plan is TDD throughout: write the failing test first, run it, watch it fail for the stated reason,
  then implement. Do not write implementation before the failing test exists.
- Run the task's own verify command. If it fails, fix the cause — never weaken the test or the gate to
  make it pass.
- Tick the task's checkboxes in the plan file as you complete each step.
- Commit with the project's trailer convention (see the commit protocol in ~/.claude/CLAUDE.md):
  conventional subject, then `Constraint:` / `Rejected:` / `Confidence:` / `Scope-risk:` / `Directive:` /
  `Not-tested:` as applicable.
- If a task's `git add` list omits a file that task created, add it. Several were incomplete; fix rather
  than work around.

## Hard constraints — these are not negotiable

- SQLite is authoritative. tmux, processes, sandboxes, worktrees, and provider sessions are recoverable
  bindings, never sources of truth.
- `DRAFT_PR_READY_FOR_HUMAN` is the only successful autonomous terminal state. Ready, approve, merge,
  bypass, and deploy operations must not exist in Local V1 application or adapter contracts.
- Control-plane credentials never enter coding runtimes.
- Redaction runs before persistence and before every egress.
- `@termbridge/control-plane` owns the durable domain; `@termbridge/core` stays the provider-neutral
  substrate. control-plane must not import provider packages, server, mcp-server, or browser code.
- No detection evasion. Provider-policy compliance is mandatory.

## Stop and ask — do not guess

Stop, explain, and wait for the human when you hit any of these:

1. **A phase gate.** Record the phase evidence under docs/evidence/autonomous-local/<phase>/, report
   each criterion with its command and exit code, and stop. Phase gates require maintainer review; do
   not start the next phase yourself.
2. **The two open state-machine questions** in Task 9. The design does not answer either: (a) which
   paused states are reachable from which active states — design says "any *applicable* active state"
   without defining applicable; (b) what state a resume transitions *to*. Surface both as decisions, do
   not invent an answer per call-site.
3. **Live credentials or external services** — Daytona/Cloudflare lifecycles, OpenCode/Claude live
   spikes, Jira/Linear/GitHub App installs, the Hermes demo. Report what the task needs and stop rather
   than fabricating evidence. An evidence file describing a run that did not happen is worse than no
   file.
4. **A contradiction between an upstream CLI or provider and the design.** Amend the ADR, spec, and plan
   first; never paper over it with a workaround.
5. **Anything that would weaken a gate, a test, or a security boundary** to make progress.

## Report honestly

At the end of the session, state: which task you completed, the real test/lint/typecheck numbers, what
you did not finish, and what is blocked and why. If something failed, show the output. Do not describe
work as complete unless its verify command actually passed.
```

---

## Notes for the operator

- **First run** will pick Task 1 (status manifest + `scripts/gate-check.ts`). That is the right start:
  until `gate-check.ts` exists, no phase gate is machine-enforced, and it also clears the stale `~900
  tests` / `v1.0.4` claims in `README.md` and `docs/ROADMAP.md`.
- **Phase 0 tasks 4, 5, 6** need live services. Credentials for E2B, Daytona, and Cloudflare are in
  `.env`, and `opencode` and `claude` are on PATH — but the agent should still surface what it is about
  to run against a real provider before it does.
- **Task 5** (Hermes/Discord demo) is the one Phase 0 item with no local prerequisite. The plan permits
  a formal defer with owner, reason, and next review date, which unblocks Task 2B immediately.
- **Phase 1 (Tasks 9–12B)** is the largest coherent autonomous stretch — fully synthetic, no live
  providers — but only after Task 8 freezes the schemas and the two open questions above are answered.
- Re-run the prompt after each gate review. It resumes from repo state, so nothing is lost between
  sessions.
