# V2 baseline audit — findings and remediation record

> **Historical record.** This is the audit that produced commit `d63419e`. Every remediation described
> below was applied to `docs/ROADMAP-V2.md`, the Autonomous Local design spec, the implementation plan,
> `docs/DECISIONS.md`, and `CLAUDE.md` in that commit. Line numbers cited here refer to the documents
> **as they stood before** the fixes, so they will not match the current files. Kept because the
> reasoning — why each gate, table, and dependency edge exists — is not recoverable from the diff alone.

## Context

An audit of the accepted V2 baseline (`docs/ROADMAP-V2.md`, the Autonomous Local design spec, the
26-task implementation plan) found the documents structurally sound but **not executable as written**.
Three independent audits plus direct measurement at `0a4afc1` turned up 12 execution blockers, an
incomplete dependency DAG, 11 unobservable gate criteria, 20 roadmap deliverables with no owning task,
and 6 cross-document contradictions.

This plan applies those fixes to the local docs. It is documentation-only — no source changes, no
commits beyond what the user asks for. The outcome is a plan an executor can run start-to-finish
without stopping to invent a missing contract, and a roadmap whose baseline numbers are true.

Two authority calls were already made by the user and are assumed throughout:
- **Restore 4A/4B/4C** as separately gated phases (the plan had collapsed them; roadmap and design
  both keep them split).
- **Amend roadmap/design wording to name `@termbridge/control-plane`** rather than moving the durable
  domain into Core.

Files touched: `docs/ROADMAP-V2.md`, `docs/superpowers/specs/2026-07-25-autonomous-local-design.md`,
`docs/superpowers/plans/2026-07-25-autonomous-local.md`, `docs/DECISIONS.md`, `CLAUDE.md`.

## Execution decisions

- **Branch:** work directly on `main`. No worktree, no feature branch.
- **Commit strategy:** the V2 docs are still untracked. Apply all five batches to them *first*, then
  commit the corrected documents as the authority baseline in one commit. This supersedes plan Task 0's
  "commit V2 docs first" step — history should not record an accepted-then-immediately-wrong baseline.
  Amend the plan's Task 0 wording to match.
- **Order:** Batch 1 → 2 → 3 → 4 → 5. Batch 1 first because later batches depend on its corrected
  wording (control-plane naming, evidence paths, 4A/4B/4C split, ADR range).
- Follow the project commit protocol in `~/.claude/CLAUDE.md`: conventional subject plus
  `Constraint:` / `Rejected:` / `Confidence:` / `Scope-risk:` trailers.

---

## Verified baseline

Measured at `0a4afc1`, clean tree, `--force` (Turbo cache defeated):

| Check | Doc claims | Measured | |
|---|---|---|---|
| Repository tests | 762 / 50 files / 1,831 expect | **754 / 49 / 1,811** | **wrong** |
| Core tests | 517 / 26 / 1,269 | 517 / 26 / 1,269 | ok |
| Orchestrator + MCP + server | 200 | 32 + 67 + 101 = 200 | ok |
| Typecheck | 8 of 8 clean | 8 of 8 clean | ok |
| Lint | 3 warnings + 2 infos | core 1w+2i, orchestrator 1w, mcp-server 1w | ok |

Per-package: core 517/26, server 101/12, mcp-server 67/3, orchestrator 32/2, sandbox-e2b 12/2,
claude-code-plugin 16/2, sandbox-daytona 5/1, sandbox-cloudflare 4/1. Zero failures, zero skips. Only
the repository-total row is stale.

---

## Batch 1 — Truth and cross-document reconciliation

Do this first; later batches assume the corrected wording.

| Edit | File / anchor | Change |
|---|---|---|
| 1.1 | `ROADMAP-V2.md` §3 L84 | `762 passing, 50 files, 1,831 expectations` → `754 passing, 49 files, 1,811 expectations` |
| 1.2 | `CLAUDE.md` L22 | same correction: `754 tests / 49 files / 1811 expectations` |
| 1.3 | `CLAUDE.md` L45–46 | **Misnumbered.** It calls the shared-service decision "D3" and the Core-substrate decision "D8", but ROADMAP §5 has V2-D3 = SSE transport and V2-D8 = managed worktree. The shared-service decision is **V2-D2**. Rewrite to reference V2-D2 correctly, and describe the Core narrowing as an amendment to *legacy* D3, not V2-D8. |
| 1.4 | `ROADMAP-V2.md` §4 L166–168 | "**Core domain** owns … repositories, leases, checkpoints" → name `@termbridge/control-plane` as the owner of the durable domain; Core keeps terminal/environment/session primitives. Matches plan L42–49. |
| 1.5 | `design` §3.1 L82–89 | Same: move `durable task-domain contracts`, `operation journal`, `CLI-driver contracts`, `workspace and evidence primitives`, `tracker and forge contracts` from the `Termbridge Core` bullet list into a new `Termbridge Control Plane` block. Leave `terminal supervision` under Core. |
| 1.6 | `ROADMAP-V2.md` L458 | "Consolidate **D1–D8** and **V2-D1–D12**" → "Consolidate D1–D4 and V2-D1–V2-D17". D5–D8 were never written; `DECISIONS.md` stops at D4. Also inconsistent with L472 and L912, which already say D17. |
| 1.7 | `DECISIONS.md` | Add a one-line note under the D1–D4 records: D5–D8 were never authored; the V2 register in ROADMAP §5 is the forward authority. Prevents Task 2B chasing four ghost ADRs. |
| 1.8 | `design` §12 L899 | "24–36 engineering weeks" contradicts ROADMAP §9, whose per-phase windows (1–2, 6–10, 10–16, 4–6, 4–6, 3–5, 4–6, 4–6) sum to **36–57 weeks**. Adopt the roadmap number. |
| 1.9 | `ROADMAP-V2.md` §14 L871 | `docs/evidence/<version>/` → `docs/evidence/autonomous-local/<phase>/` for phase gates and `.../release/` for release bundles, matching the plan's actual layout. |
| 1.10 | `ROADMAP-V2.md` §9 L526 + L547 | Phase 1 lists "streaming and structured redaction" and gates "zero canary-secret leaks", but the `StreamingRedactor` lands in Phase 3 Task 18 — **the gate asserts a property before the code exists.** Narrow L526 to the shared canary corpus + Phase 1 surfaces; move the full-egress claim to the Phase 3 gate. |

---

## Batch 2 — Plan blockers

All anchors in `docs/superpowers/plans/2026-07-25-autonomous-local.md`.

**2.1 Missing events table (Task 10, L891–901).** `0001_initial.sql` is the plan's only migration and
creates 18 tables + `lease` + `schema_migrations` — no events table. But Task 12A requires an
`EventStore` with gap-free monotonic per-task sequences surviving reopen (L1037–1039) and demands
"the state transition, audit record, **and emitted events**" in one transaction (L1095). Add
`task_events` (task_id, sequence, event_id, kind, schema_version, payload, previous_event_hash,
created_at; unique (task_id, sequence); unique event_id) to Step 3, add "event append" to the
single-transaction list at L910, and add the table to design §6.3 after `audit_events` (L468).

**2.2 `runtime_bindings` never created (Task 11, L957 and L979–980).** Zero hits in the design.
Design §6.3 `runtime_sessions` (L453–455) is the intended table. Replace both references.

**2.3 Fence columns undeclared (Task 10, L911–913).** Every durable mutation must carry
`WHERE lease_id = ? AND fencing_token = ?`, but no table declares either column. Name them explicitly
in Step 3 on `task_runs`, `external_operations`, `task_events`, `workspaces`.

**2.4 Five commits fail as written.** `git add` targets evidence dirs no step creates: L1177
(`phase-1`), L1546 (`phase-3`), L1648 (`phase-4a`), L1743 (`phase-4b`), L1797 (`phase-4c`). `git add`
on a nonexistent path exits nonzero. Give each task an explicit "author the phase evidence record"
step before its commit step — which also closes the matching gate criteria in Batch 4.

**2.5 Task 8 freezes no payload types (L654–657, L667–679).** All 28 design §7 method names are frozen;
none of the ~36 parameter/return types are — `TrackerCapabilities`, `RawWebhook`, `VerifiedDelivery`,
`WebhookRegistration`, `TrackerChange`, `NormalizedWorkItem`, `WorkItemContext`, the four
`Publish*Command`s, `ExternalReference`, `WorkflowDescription`, `ExternalState`, `CliCapabilities`,
`StartSession`, `SessionHandle`, `DriverInstruction`, `HumanAnswer`, `CancelResult`, `RuntimeBinding`,
`RecoveredSession`, `SessionEvidence`, `RepositoryId`, `ForgeCapabilities`, `RepositoryRules`,
`BranchRef`, `BranchState`, `DeliveryKey`, `DraftPullRequest`, `PushCandidateCommand`, `BranchResult`,
`CreateDraftPullRequestCommand`, `UpdateDraftPullRequestCommand`, `PullRequestId`, `CheckSummary`.
Add a Task 8 step defining all of them as Zod schemas in `ports/*.ts`; list them in Interfaces.

**2.6 `DriverEvent` kinds not enumerated (L672).** Design L519–521 names 10: activity, question,
permission request, plan deviation, idle, candidate ready, rate limit, authentication required,
failure, termination. Task 8 only asserts each has "a stable discriminant" — a property over an
unspecified set. Enumerate as a closed union, same shape as `TaskState` at L717–740.

**2.7 Task 8's Files list omits its own test files (L635–650, L784, L687).** Step 1 mandates
`ports/cli-driver.contract.test.ts`, `ports/tracker.contract.test.ts`, `ports/forge.contract.test.ts`;
none appear in Create, `git add`, or the verify command. Add to all three.

**2.8 Zero state transitions specified.** Task 8 defines the 23-state union and no edges; Task 9 defers
the whole table to an unenumerated `Record<TaskState, readonly TaskState[]>` (L829). Enumerate the
design's 17 edges and 4 named guards ("approved plan hash", "tests pass", "review passes", "checks
pass") plus the 9-target pause fan-out. Record two questions the design itself leaves open: which
paused states are reachable from which active states ("any *applicable* active state", design L383),
and what state a resume goes *to* (design L395).

**2.9 Success invariants and invalidation causes under-specified.** Design L369–379 lists 9 conditions
for `DRAFT_PR_READY_FOR_HUMAN`; Task 9 says "all success invariants" naming none, and Task 12B's tracer
asserts only "exactly one task, branch, fake PR, and terminal success record" (L1172). Design L397–399
lists 9 invalidation causes; the plan's only concrete list (Task 21, L1673–1674) has 4 — missing stale
base beyond policy, plan changes, selected driver changes, required reviewer changes, security
classification changes. Enumerate all 9 of each, one assertion apiece.

**2.10 Policy YAML ~1/3 covered, one field tested under the wrong key.** Task 16 covers ~11 of ~32
design §8 leaf fields. Zero plan hits for `trigger_state_id`, `cancellation_states`,
`authorized_approver_ids`, `base_branch`, **`allowed_paths`**, `max_iterations`, `wall_clock_minutes`,
`budget_units`, `draft_only`, `allow_mark_ready`, and all three `retention.*`. Two specific defects:
- Design uses `delivery.allow_merge`; Task 8 L661 asserts `delivery.allowMerge: true` fails. Zero hits
  for `allow_merge` in the plan, zero for `allowMerge` in the design — **the test does not test the
  design's key.** Fix the key.
- Only `denied_paths` is enforced (L1440). `allowed_paths` — the allowlist half of the containment
  model — is unimplemented. Enforce both halves.

**2.11 Task 12A malformed.** Two steps labelled "Step 7" (L1093 implement, L1121 commit) with Step 8
between. Its `git add` (L1124–1130) omits `packages/sdk`, `redaction/canary-corpus.ts(.test.ts)`,
`testing/env-conformance.ts`, `mcp-server/src/golden/` — all files it creates. L1109 runs `bun test`
against `env-conformance.ts`, a non-`.test.ts` harness. Renumber, complete the git add, add
`env-conformance.test.ts` to Files.

---

## Batch 3 — Dependency DAG

Only 7 of 28 task headings carry `Depends on:` (2B, 8, 12A, 12B, 14, 15, 25); 16 declare nothing. No
cycle exists — every implicit edge points backwards. But the plan's own header (L3) tells the executor
to use `superpowers:subagent-driven-development`, which parallelizes on declared edges, so as written
it will dispatch 9/10/11 together, 20 before 19, and 22/23 before the drivers exist. The only guards
are narrative sentences (L1962).

Add:

| Task | `Depends on:` | Evidence |
|---|---|---|
| 9 | 8 | Writes into the package Task 8 scaffolds; Interfaces L811 consumes four Task 8 types; verify runs Task 8's test |
| 10 | 8, 9 | Needs `AuditEvent` and `transitionTask` for its atomic-transition test (L869) |
| 11 | 8, 10 | Fence tests (L962–964) need the `lease` table from Task 10 Step 3 |
| 13 | 8 | Creates `control-plane/src/workspace/**` |
| 14 | +8, 2A | Implements `CodingCliDriver` (L1260); also moves `provisioner.ts` / touches `engineer-loop.test.ts`, both edited by Task 2A |
| 15 | +8 | Implements `CodingCliDriver` (L1356) |
| 16 | 12A, 3 | Consumes the canary corpus (L1442) and Task 3's grader shape |
| 17 | 12B, 16 | Modifies `task-service.ts` and `synthetic-tracer.test.ts`, both created by 12B |
| 18 | 12A | Redactor tests enumerate exactly the 12A corpus surfaces |
| 19 | 8 | `WebhookInbox` lives in control-plane, stores `SecretRef` |
| 20 | 12A, 12B, 16, 17, 18, 19 | Lives inside Task 19's package; `pr-body.ts` consumes verification/review/evidence; verify runs 19's and 12B's tests |
| 21 | 9, 12A, 19 | Modifies 12A's `v2-tasks.ts`; needs `validateApproval` and `WebhookInbox.receive` |
| 22 | 8, 13, 14, 15, 16, 19, 20, 21 | Live matrix L1736–1738 needs both drivers, worktrees, verification, forge, approval path |
| 23 | same as 22 | Verbatim same for Jira (L1790–1792) |
| 24 | 8, 10, 11, 12A, 12B, 14, 15, 18, 19, 20, 21, 22, 23 | Composition root injecting "SQLite, secret provider, drivers, trackers, forge, scheduler, and application services" (L1830–1831) |
| 25 | +14, 15, 24 | 20×3 matrix needs both CLIs; install/backup/restore needs the composition root |
| 12A | +4 | Env conformance runs against "each non-deferred provider" (L1090); Task 4 decides that set |

Also fix the asymmetry at L683–684: Task 8's body asserts Tasks 14/15/19/20/22/23 depend on it, but
none of them say so. The table resolves it.

---

## Batch 4 — Gate executability

37 criteria across 6 gates: 17 observable, 9 partial, **11 descriptive**. There is no gate between
Task 24 and Task 25, so Phase 5's UI deliverable is gated only by the release gate.

**4.1 Unbounded universal negatives** — assertable but never observable. Bind each to its existing
enumeration:
- L1184 "canary corpus is absent from all tested surfaces" → cite the 13 surfaces at L1051–1053
- L1185–1186 "rejects every durable mutation after lease expiry" → cite the 4 mutations at L962–964
- L1550 "no evidence can be reused across SHAs" → cite the candidate-SHA binding assertions
- L1551 "secret canaries absent from all tested surfaces" → cite L1527–1528
- L1802 "no control-plane credential enters a coding runtime" → Task 14 has real assertions (L1271,
  L1278–1279); **Task 15 has none**. Add the matching negative-environment assertion to Task 15.

**4.2 Criteria naming artifacts that exist nowhere.**
- L1410 "containment suites" — `containment` appears exactly once in 2,028 lines, in the gate itself.
  Name the suite files or drop the phrase.
- L1937 "every critical case is 3/3" — **uncomputable.** Task 3's manifest schema (L343–347) has no
  criticality field, so no manifest can mark a case critical. ROADMAP §10 L781–785 already names all
  18 scenarios. Add a required `critical_scenario` enum to the Task 3 schema seeded from that list,
  and make the manifest test reject a manifest missing any of the 18.

**4.3 Replace 6 descriptive criteria with commands**, using the pattern the plan already demonstrates
(Task 7's `rg -n '^## (…)$'` at L618–620; Task 6's credential scan with `exit 1` at L555–558; Task 3's
schema-rejection test at L353–355; Task 20's compile-time absence assertion at L1637–1640):

| Line | Criterion | Replacement |
|---|---|---|
| L788 | "Every Phase 0 task … is complete" | `scripts/gate-check.ts --phase 0`: zero unchecked `- [ ]` in the phase's task blocks |
| L789 | "V2-D1–V2-D17 … are accepted" | `rg -c '^## V2-D([1-9]\|1[0-7]) ' docs/DECISIONS.md` equals 17 |
| L790 | "ARCHITECTURE.md reflects V2" | `rg` section check, same shape as Task 7 |
| L793 | "schemas are versioned with spike evidence incorporated" | assert the frozen `DriverEvent` schema hash equals the hash recorded in `opencode-spike.md` |
| L1186 | "Live provider work remains unstarted until this gate is reviewed" | reviewer sign-off record at `phase-1/gate.md` with a required field set |
| L1955–56 | "the pilot records zero lost tasks, duplicate runs/PRs, …" | `pilot-ledger.schema.json` + validator, mirroring Task 1's `ProjectStatus` / `status:check` (L154, L172–185) |

**4.4 Mis-scoped criterion.** Phase 1's "backup/restore reproduces active tasks" (L1181–1182) is backed
by a storage-level test in Task 10 (L871), but `scripts/backup-local.ts` / `restore-local.ts` don't
exist until Task 25 (L1868–1869). Reword to "SQLite backup/restore conformance passes"; the
script-level lifecycle check stays in the Stable gate.

**4.5 Phase 3 gate omits two of its own headline deliverables** — Task 16's final-diff scanner
(L1439–1442) and Task 18's evidence-bundle blocking (L1538). Add both.

**4.6 Add `scripts/gate-check.ts` to the plan.** Global Constraint L34 requires phase evidence under
`docs/evidence/autonomous-local/<phase>/` but nothing verifies it. One script, one command per phase:
every task checkbox in the phase checked, the phase evidence file exists and validates against a small
schema (command, exit code, git SHA, timestamp, artifact paths), and the phase's named test commands
exit zero. This is what converts the gates from reviewed to observed.

**4.7 Split the Phase 4 gate into 4A/4B/4C** (user's call). Plan L1555 and L1801–1803 collapse what
roadmap L642–706 and design §12 L874–891 keep separate. **4A** (Tasks 19–20): exactly-one draft
delivery + crash/reconciliation + compile-time absence of merge-equivalent operations. **4B** (Tasks
21–22): Linear live E2E. **4C** (Task 23): Jira live E2E. Each writes to its existing
`phase-4a`/`4b`/`4c` directory — which also fixes three of the five broken commits in 2.4.

---

## Batch 5 — Roadmap coverage gaps

Twenty deliverables with no owning task. Assign homes:

| # | Gap | Roadmap | Lands in |
|---|---|---|---|
| 1 | Human takeover / attachment / return-to-agent — `takeover` = **0 hits in plan**, 6 in roadmap | L588, L606, L781 | **New Task 15B** (Phase 2) + a Task 24 dashboard step |
| 2 | Diagnostic export (allowlist, preview, redaction manifest, consent) | L391, L720 | Task 18, new step |
| 3 | Retention enforcement — `retention` = **0 hits in plan**, 6 in design, and design §12 L858 lists it as a Phase 2 deliverable | L536, L716 | Task 16 (parse), Task 13 (worktree pruning), Task 11 (event retention) |
| 4 | Benchmark **20-case set** — Task 3 gates ≥4 *fixtures*; nothing authors 20 *cases*; Task 25 L1892 runs them | L769 | Task 3, new step |
| 5 | Grader categories — design §11.4 L806–808 requires 10 (incl. config change, diagnosis, security validation, clarification, intentionally unsafe requests); plan pins 4 | design L806–808 | Task 3 + Task 16 |
| 6 | Latest-upstream canaries; nightly smoke policy | L770–771 | Task 25 + `ci.yml` |
| 7 | Regression vs previous stable in benchmark output | L776–777 | Task 25 Step 1 |
| 8 | SBOM / provenance | L820 | Task 25 + `ci.yml` |
| 9 | Threat model (Local, CLI adapter, sandbox, Git, forge, browser, supply chain) | L818–819 | **New Task 2C** (Phase 0, doc-only) |
| 10 | Dependency review + static checks per stable candidate | L821–822 | Task 25 + `ci.yml` |
| 11 | Per-release compatibility matrix; stdio + Streamable HTTP statement (`stdio` = 0 hits in plan) | L832 | Task 12A (statement) + Task 25 (matrix) |
| 12 | Migration dry-run + schema-compatibility evidence | L838–839 | Task 10, new step |
| 13 | Fail startup on non-loopback bind (V2-D11) | L790–791 | Task 24 |
| 14 | WebSocket — roadmap §4 L172 and V2-D3 reserve it for terminal/browser attach and L814 requires Origin validation + per-message authz; **0 hits in plan and design**, though V1 already ships WS routes | L204, L153, L814 | Task 12A: explicit scope + tests |
| 15 | Changed-file and wall-clock limits | L630 | Tasks 16/17; also add a changed-file cap to design §8, which has none |
| 16 | Stable error catalog | L523 | Task 8 |
| 17 | Phase 0 exit "installation and Local/Docker/E2B smoke paths reproducible" | L485 | Task 4, new step |
| 18 | `graders.ts` — listed at plan L1426 with no authoring step or test | L626 | Task 16 |
| 19 | Release bundle contents (compatibility matrix, migration report, security review) | L871–873 | Task 25 (path reconciled in 1.9) |
| 20 | Legacy ADR consolidation vs a `DECISIONS.md` that stops at D4 | L458 | Task 2B (wording fixed in 1.6/1.7) |

---

## Verification

Run after the edits land:

1. **Baseline true.** `bun run test -- --force`, `bun run typecheck`, `bun run lint -- --force`.
   Confirm ROADMAP §3 and CLAUDE.md both read 754 / 49 / 1,811, 8/8 clean, 3 warnings + 2 infos.
2. **No dangling identifiers.** `runtime_bindings` → 0 hits in the plan. `task_events`, `retention`,
   `allowed_paths`, `allow_merge`, `takeover`, `WebSocket`, `stdio`, `SBOM`, `critical_scenario` →
   each ≥1 hit in the plan.
3. **DAG complete.** `grep -c 'Depends on:'` in the plan returns 21 (was 7) across 30 task blocks —
   every task from 9 onward plus 2B and 8. Tasks 0–7 stay covered by the explicit Phase 0 sequencing
   paragraph, which is itself a dependency statement. Topologically sort the edges; confirm no cycle.
4. **Commits runnable.** Every `git add` path is either a `Create:` entry in the same task or authored
   by an explicit step in it — check the five evidence directories from 2.4 specifically.
5. **Gates observable.** Every gate criterion cites a command, a test file, or an artifact path. Zero
   `all` / `every` / `no … exists` phrasings without an accompanying enumeration.
6. **Coverage closed.** Each of the 20 rows in Batch 5 resolves to a named task and step.
7. **Fidelity re-check.** Re-run the three audits against the revised docs; confirm the §7 payload
   types, 10 `DriverEvent` kinds, 17 transitions, 9 success invariants, 9 invalidation causes, and
   ~32 §8 policy fields each now appear in the plan.
