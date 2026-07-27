# Termbridge Autonomous Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the open-source single-user Local daemon that turns configured Jira or Linear workflow-state changes into exact-plan-approved, fully tested, optionally independently reviewed GitHub draft pull requests through Claude Code or OpenCode.

**Architecture:** Add a provider-neutral `@termbridge/control-plane` package for durable domain/application logic and SQLite, isolate each CLI/tracker/forge integration in its own package, and keep `@termbridge/server` as the Local composition root and browser host. Migrate the existing engineer loop behind the new driver/application contracts instead of extending its process-local orchestration or in-session delivery path.

**Tech Stack:** Bun 1.3.5, TypeScript 5.7, `bun:sqlite`, Hono, Zod 3, tmux, Git worktrees, GitHub REST/webhooks, Linear GraphQL/OAuth/webhooks, Jira Cloud REST v3/OAuth 2.0 3LO/dynamic webhooks, Biome, Turbo.

**Design:** [Autonomous Local design](../specs/2026-07-25-autonomous-local-design.md)

**Research:**

- [Jira, Linear, and GitHub workflows](../../research/2026-07-24-jira-linear-github-autonomous-workflows.md)
- [Durable architecture](../../research/2026-07-11-roadmap-v2-durable-platform-architecture.md)
- [CLI adapters](../../research/2026-07-11-cli-adapters-codex-opencode.md)

## Global Constraints

- The first stable release is open source, single user, locally hosted, and loopback-bound by default.
- SQLite is authoritative; tmux, processes, sandboxes, worktrees, and provider sessions are recoverable bindings.
- Jira Cloud and Linear are mandatory tracker adapters.
- Claude Code and OpenCode are mandatory coding drivers; Codex is deferred.
- A verified human must approve the exact plan hash, issue snapshot hash, base SHA, and policy version before a writable workspace exists.
- Polling/reconciliation is the tracker correctness baseline; signed webhooks only accelerate intake.
- `DRAFT_PR_READY_FOR_HUMAN` is the only successful autonomous terminal state.
- Ready, approve, merge, bypass, and deployment operations must not exist in Local V1 application or adapter contracts.
- Required verification and review bind to the exact candidate SHA and cannot be waived by the coding runtime or budget exhaustion.
- Consequential effects use `prepared → dispatched → confirmed`, with unprovable outcomes entering `uncertain`.
- Control-plane credentials never enter coding runtimes.
- Redaction runs before persistence and before every egress.
- Every implementation task uses TDD and ends with the smallest relevant test suite plus `bun run typecheck`.
- Do not begin a later phase until the previous phase exit gate is recorded under `docs/evidence/autonomous-local/<phase>/`.

---

## File and package map

### Existing packages retained

- `packages/core`: terminal/environment/session primitives. Remove Claude/GitHub assumptions incrementally; do not put tracker logic here.
- `packages/orchestrator`: compatibility facade for `runEngineerLoop`; migrate callers to control-plane services and deprecate in-session delivery.
- `packages/server`: Local composition root, loopback HTTP/events/webhooks, browser UI, setup, and process lifecycle.
- `packages/mcp-server`: legacy 13-tool compatibility adapter over shared application/session services.

### New packages

- `packages/control-plane`: domain models, state machine, policy, application services, repository ports, SQLite, operation journal, reconciliation, evidence, redaction, and test fakes.
- `packages/driver-claude`: Claude Code lifecycle driver and pinned compatibility fixtures.
- `packages/driver-opencode`: OpenCode HTTP/OpenAPI/SSE lifecycle driver and pinned compatibility fixtures.
- `packages/forge-github`: GitHub App authentication, webhook normalization, deterministic branch/draft-PR delivery, checks, and reconciliation.
- `packages/tracker-linear`: Linear OAuth/app actor, GraphQL, webhook, workflow, and publishing adapter.
- `packages/tracker-jira`: Jira 3LO, REST v3, ADF, dynamic webhook, workflow, and publishing adapter.

Every new integration package starts at `0.1.0`, uses the repository's standard build/test/typecheck/lint
scripts, exports `./src/index.ts`, and declares only these workspace dependencies:

| Package | Workspace dependencies |
|---|---|
| `driver-claude` | `@termbridge/core`, `@termbridge/control-plane` |
| `driver-opencode` | `@termbridge/control-plane` |
| `forge-github` | `@termbridge/control-plane` |
| `tracker-linear` | `@termbridge/control-plane` |
| `tracker-jira` | `@termbridge/control-plane` |

### Dependency direction

```text
core ← drivers
  ↑
control-plane ← tracker-linear
      ↑       ← tracker-jira
      ↑       ← forge-github
      │
orchestrator compatibility
      ↑
server composition root + UI
      ↑
mcp-server compatibility
```

Provider packages implement control-plane ports. `control-plane` cannot import provider packages,
`server`, `mcp-server`, or browser code.

---

## Phase 0 — Truth, ADRs, executable contracts, and live spikes

**Sequencing:** Task 0 first. Tasks 1, 2A, 2C, 3, 4, 5, 6, and 7 may then run in parallel because they
own disjoint files. Task 2B follows Tasks 1, 4, and 5 and is the only post-baseline task allowed to edit
`ROADMAP-V2.md`. Task 8 requires spike evidence from Tasks 6 and 7 before freezing schemas. The Phase 0
gate requires every task, including Tasks 2B and 2C.

### Task 0: Commit V2 authority documents

**Files:**

- `docs/ROADMAP-V2.md`
- `docs/superpowers/specs/2026-07-25-autonomous-local-design.md`
- `docs/superpowers/plans/2026-07-25-autonomous-local.md`
- `docs/research/2026-07-24-jira-linear-github-autonomous-workflows.md`
- `docs/research/2026-07-11-roadmap-v2-durable-platform-architecture.md`
- `docs/research/2026-07-11-cli-adapters-codex-opencode.md`
- `docs/DECISIONS.md`
- `CLAUDE.md`

**Interfaces:**

- Produces: a single commit establishing the V2 roadmap, design, plan, and research as the accepted
  authority baseline before any code work.

**Audit remediation applied first.** These documents were audited before this commit and corrected in
place: the baseline test numbers, the control-plane package boundary, the 4A/4B/4C phase split, the
dependency DAG, the executable phase gates, and the roadmap coverage gaps. The corrected documents are
what gets committed — history records one accepted baseline, not an accepted-then-immediately-wrong one.
`docs/DECISIONS.md` and `CLAUDE.md` join the commit because the same audit corrected the ADR numbering
in both.

- [x] **Step 1: Stage all six V2 documents**

Run:

```bash
git add docs/ROADMAP-V2.md \
  docs/superpowers/specs/2026-07-25-autonomous-local-design.md \
  docs/superpowers/plans/2026-07-25-autonomous-local.md \
  docs/research/2026-07-24-jira-linear-github-autonomous-workflows.md \
  docs/research/2026-07-11-roadmap-v2-durable-platform-architecture.md \
  docs/research/2026-07-11-cli-adapters-codex-opencode.md \
  docs/DECISIONS.md CLAUDE.md
git diff --cached --name-only
```

Expected: exactly the eight listed paths, with no other staged file.

- [x] **Step 2: Commit**

```bash
git commit -m "docs: accept v2 roadmap, autonomous local design, plan, and research"
```

Expected: one commit containing only the eight authority documents.

### Task 1: Generate repository status and eliminate documentation drift

**Files:**

- Create: `scripts/project-status.ts`
- Create: `scripts/project-status.test.ts`
- Create: `scripts/gate-check.ts`
- Create: `scripts/gate-check.test.ts`
- Create: `docs/evidence/autonomous-local/gate-evidence.schema.json`
- Create: `docs/evidence/status.json`
- Create: `docs/evidence/status.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/PLAN.md`

**Interfaces:**

- Produces: `collectProjectStatus(root: string): Promise<ProjectStatus>`
- Produces: `renderProjectStatus(status: ProjectStatus): { json: string; markdown: string }`
- Produces: `bun run status:check`, which exits nonzero when tracked generated evidence drifts.
- Produces: `bun scripts/gate-check.ts --phase <0|1|2|3|4a|4b|4c|release>`, which exits nonzero unless
  (a) every task checkbox in that phase is checked, (b) the phase's evidence file exists and validates
  against `gate-evidence.schema.json`, and (c) every command the phase gate names exits zero. Global
  Constraint 14 requires phase evidence but nothing verified it; this is that check. Build it in Phase 0
  so every later gate has a runnable form from the start.

- [ ] **Step 1: Write the failing manifest tests**

Test a fixture workspace containing two package manifests and recorded test/lint results. Assert sorted
package versions, repository SHA, command metadata, package/repository test counts, and stable Markdown.

- [ ] **Step 2: Run the focused test**

Run: `bun test scripts/project-status.test.ts`

Expected: FAIL because `collectProjectStatus` does not exist.

- [ ] **Step 3: Implement deterministic collection and rendering**

Use typed records:

```ts
export interface ProjectStatus {
  schemaVersion: 1;
  generatedAt: string;
  gitSha: string;
  packages: Array<{ name: string; version: string; classification: string }>;
  checks: Array<{
    name: string;
    command: string;
    exitCode: number;
    passed: number | null;
    files: number | null;
  }>;
}
```

Make `--check` regenerate in memory and compare exact tracked content without rewriting.

- [ ] **Step 4: Wire CI and correct stale authority claims**

Add `status:generate` and `status:check` scripts. Replace hand-maintained test/version tables with links
or generated blocks. Mark `docs/ROADMAP.md` and `docs/PLAN.md` historical.

- [ ] **Step 5: Verify**

Run: `bun test scripts/project-status.test.ts && bun run status:generate && bun run status:check`

Expected: PASS and no generated drift.

- [ ] **Step 6: Commit**

```bash
git add scripts/project-status.ts scripts/project-status.test.ts package.json \
  .github/workflows/ci.yml README.md CHANGELOG.md docs/ROADMAP.md docs/PLAN.md \
  docs/evidence/status.json docs/evidence/status.md
git commit -m "docs: generate canonical project status"
```

### Task 2A: Clear lint debt

**Files (verified against `bun run lint` at `0a4afc1`):**

- Modify: `packages/core/src/auth/provisioner.ts` (unused imports — `existsSync`, `mkdirSync`, `statSync`)
- Modify: `packages/core/src/env/docker.ts` (two optional-chain/style diagnostics at L88, L119)
- Modify: `packages/mcp-server/src/tools.ts` (explicit `any` at L20)
- Modify: `packages/orchestrator/src/engineer-loop.test.ts` (unused import at L35)

**Baseline:** `bun run lint` reports **3 warnings + 2 infos** across these four files (not the "1
warning + 2 infos" in the older roadmap snapshot — that count is stale).

**Interfaces:**

- Produces: zero-diagnostic `bun run lint`.

- [ ] **Step 1: Capture current lint output with file paths**

Run:

```bash
bun --silent run lint 2>&1 | grep -oE '[a-z./-]+\.ts:[0-9]+:[0-9]+' | sort -u
```

Expected: exactly the four paths listed above (or their current equivalents if the snapshot drifted).

- [ ] **Step 2: Fix only reported diagnostics in each named file**

- `provisioner.ts`: remove the unused `existsSync`/`mkdirSync`/`statSync` imports that Biome flags.
- `docker.ts`: fix the two optional-chain/style diagnostics at the reported lines.
- `tools.ts`: replace the explicit `any` at L20 with a typed alternative or `unknown`.
- `engineer-loop.test.ts`: remove the unused import at L35.

Do not mix structural refactoring into this task. If a diagnostic is in a file not listed above, stop and
record the drift before editing — the baseline may have changed.

- [ ] **Step 3: Verify**

Run: `bun run lint && bun run typecheck && bun test`

Expected: zero lint diagnostics (0 warnings, 0 infos), clean typecheck, and all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/auth/provisioner.ts packages/core/src/env/docker.ts \
  packages/mcp-server/src/tools.ts packages/orchestrator/src/engineer-loop.test.ts
git commit -m "style: clear existing lint diagnostics"
```

### Task 2B: Accept Autonomous Local ADRs and consolidate documentation authority

**Depends on:** Task 1 status evidence, Task 4 sandbox classification evidence, and Task 5 Hermes
evidence/defer record.

**Files:**

- Modify: `docs/DECISIONS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP-V2.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: accepted V2-D1 through V2-D17 records plus the D3/D8 supersession.
- Produces: one canonical status/classification update based on Tasks 1, 4, and 5.

- [ ] **Step 1: Rewrite DECISIONS.md to accept V2 decisions**

Add accepted records for V2-D1 through V2-D17 with their migration consequences. Explicitly record the
D3 amendment (shared application/domain service canonical; HTTP primary; MCP sibling) and D8 narrowing
(Core stays substrate; Local/Platform may orchestrate above Core).

- [ ] **Step 2: Rewrite ARCHITECTURE.md for V2**

Add target Core/Local/Platform layering, application/domain services, operation journal, durable task
engine, HTTP+SSE primary with MCP sibling, CLI-driver separation, host-side draft delivery, and the V1
migration path. Preserve the existing V1 tmux architecture under a clearly labeled current-reality
section.

- [ ] **Step 3: Apply one evidence-backed authority update**

Use `docs/evidence/status.json`, Task 4's Daytona/Cloudflare evidence, and Task 5's Hermes evidence to
update `ROADMAP-V2.md`, README, and CHANGELOG. Do not claim lifecycle support or demo completion that the
evidence does not prove.

- [ ] **Step 4: Verify**

Run: `bun run status:check && bun run lint && bun run typecheck && bun test`

Expected: generated status is current, documentation classifications match evidence, lint/typecheck are
clean, and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/ARCHITECTURE.md docs/ROADMAP-V2.md README.md CHANGELOG.md
git commit -m "docs: accept autonomous local architecture"
```

### Task 2C: Write the Local threat model

Roadmap §11 makes a threat model release-blocking security work, but no task produced one. It is
documentation-only and has no code dependencies, so it runs in parallel with the rest of Phase 0.

**Files:**

- Create: `docs/security/threat-model.md`

**Interfaces:**

- Produces: an accepted threat model covering the seven surfaces roadmap §11 names.

- [ ] **Step 1: Enumerate assets, actors, and trust boundaries**

Assets: subscription credentials, tracker and GitHub App credentials, repository contents, task
evidence, and the operator's host. Actors: the operator, the driven CLI, the tracker, the forge, and
any untrusted issue author. Boundaries: loopback HTTP, the MCP stdio channel, the sandbox, the worktree,
and the browser session.

- [ ] **Step 2: Analyze each of the seven required surfaces**

One section each, with `## ` headings so the Phase 0 gate can check them: Local daemon, CLI adapter,
sandbox, Git, forge, browser, and supply chain. For each, record the threats, the existing mitigation,
the residual risk, and the test or gate that holds the mitigation honest. Treat issue text and
repository files as untrusted input throughout — prompt injection reaching a privileged operation is
the highest-severity path in this product.

- [ ] **Step 3: Record accepted risks and their review triggers**

Anything not mitigated gets an owner, a reason, and a next review date, matching the defer policy in
roadmap §15.

- [ ] **Step 4: Verify and commit**

Run: `rg -n '^## (Local daemon|CLI adapter|Sandbox|Git|Forge|Browser|Supply chain)$' docs/security/threat-model.md`

Expected: all seven sections present.

```bash
git add docs/security/threat-model.md
git commit -m "docs: add local threat model"
```

### Task 3: Commit benchmark manifest schema, fixtures, and budget policy

**Files:**

- Create: `benchmarks/autonomous-local/manifest.schema.json`
- Create: `benchmarks/autonomous-local/manifest.schema.test.ts`
- Create: `benchmarks/autonomous-local/manifest.json`
- Create: `benchmarks/autonomous-local/fixtures/README.md`
- Create: `docs/evidence/autonomous-local/phase-0/benchmark-policy.md`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Produces: a versioned JSON schema for the 20-task × 3-attempt benchmark matrix.
- Produces: a declared fixture set with license, commit SHA, content hash, and container digest.
- Produces: a budget policy document declaring per-CLI wall-clock and provider-cost ceilings.

- [ ] **Step 1: Install the schema validator and write the failing test**

Run: `bun add --dev ajv@8.17.1`

Create `manifest.schema.test.ts` using Ajv. Assert a complete case passes and that unknown keys, missing
license/SHA/hash/digest, missing deterministic grader, and missing predeclared cost ceiling fail.

- [ ] **Step 2: Run the test before creating the schema**

Run: `bun test benchmarks/autonomous-local/manifest.schema.test.ts`

Expected: FAIL because `manifest.schema.json` does not exist.

- [ ] **Step 3: Write the manifest schema**

Define a JSON Schema requiring, per case: fixture repository archive/commit, license, content hash,
container image digest; task, acceptance criteria, setup, deterministic grader, time limit; CLI binary/build,
adapter version/schema hash, model/settings, Termbridge SHA, environment/provider, network policy; scripted
intervention or fault and injection point; success and policy-violation rubrics; required evidence, elapsed
time, usage proxy, infrastructure-invalid classification.

Also require a `critical_scenario` field: a nullable enum over the 18 scenarios roadmap §10 names —
plan rejection, stale approval, attempted planning mutation, permission scope, human takeover and
return, daemon death at each operation boundary, secret canary, auth expiry, tracker revocation,
duplicate webhook, out-of-order webhook, rate limit, lost event consumer, interrupted dirty worktree,
blocking review, uncertain push/PR creation, branch tampering, and runtime conflict. Without this field
the stable gate's "every critical case is 3/3" is uncomputable — nothing can mark a case critical.

Require a `grader_category` field covering the 10 categories in design §11.4: localized fixes,
multi-file features, API changes, migrations, frontend/E2E work, configuration changes, diagnosis,
security validation, clarification, and intentionally unsafe requests.

- [ ] **Step 4: Declare four fully pinned licensed fixture repositories**

Record fixture URL, commit SHA, license, content hash, and container digest for at least four small,
redistributable fixture repos covering localized fixes, multi-file features, API/migration work, and
frontend/E2E work. The manifest test must reject fewer than four unique fixtures, non-40-character Git
SHAs, missing SPDX license identifiers, missing SHA-256 content hashes, and unpinned image tags.
Candidate fixtures may be documented separately, but placeholders never count toward this gate.

- [ ] **Step 5: Author the 20 benchmark cases**

Fixtures are not cases. Four pinned repositories host twenty authored cases; Task 25 runs "each of 20
tasks three clean times per required CLI" against a case set that must exist before it can run. Write
all 20 into `manifest.json`, each with its task statement, acceptance criteria, deterministic grader,
time limit, `grader_category`, and `critical_scenario` (null for non-critical cases). Every one of the
18 critical scenarios must be claimed by at least one case. The manifest test rejects a manifest with
fewer than 20 cases, an unclaimed critical scenario, or an uncovered grader category.

- [ ] **Step 6: Document the budget policy**

Declare per-CLI wall-clock and provider-cost ceilings before execution. Document that exceeding a ceiling
blocks the candidate or requires a new manifest version; the ceiling is never retroactively raised.
Declare the infrastructure-invalid rerun rate cap here as a manifest field, not as runner prose.

Also declare the two run modes roadmap §10 requires beside the stable matrix: **latest-upstream
canaries**, which run separately and never auto-expand the supported version range, and **nightly
smoke**, one attempt per case, which never substitutes for the stable matrix.

- [ ] **Step 7: Verify**

Run: `bun test benchmarks/autonomous-local/manifest.schema.test.ts`

Expected: PASS with four or more fully pinned licensed fixtures, 20 authored cases, all 18 critical
scenarios claimed, every grader category covered, and no schema error.

- [ ] **Step 8: Commit**

```bash
git add benchmarks/autonomous-local docs/evidence/autonomous-local/phase-0 \
  package.json bun.lock
git commit -m "docs: freeze autonomous local benchmark schema and fixtures"
```

### Task 4: Live-validate Daytona and Cloudflare, then release or defer

**Files:**

- Run: `scripts/smoke-sandbox-daytona.ts` (exists)
- Run: `scripts/smoke-sandbox-cloudflare.ts` (exists)
- Create: `docs/evidence/autonomous-local/phase-0/daytona-live.md`
- Create: `docs/evidence/autonomous-local/phase-0/cloudflare-live.md`
- Create: `docs/evidence/autonomous-local/phase-0/install-smoke.md`

**Interfaces:**

- Produces: a dated classification (released-experimental or deferred) for each sandbox package.

- [ ] **Step 1: Check credential availability without printing values**

Run:

```bash
bun --env-file=.env -e '
for (const name of ["DAYTONA_API_KEY", "CLOUDFLARE_API_TOKEN"]) {
  console.log(`${name}=${process.env[name] ? "configured" : "missing"}`);
}'
```

Expected: one configured/missing line per credential and no secret values.

- [ ] **Step 2: Run the Daytona lifecycle smoke or record defer evidence**

Run: `bun --env-file=.env scripts/smoke-sandbox-daytona.ts`

Passing evidence requires create, drive, and delete to succeed. Record package/SDK version, command,
timestamp, redacted output, resource identifier hash, and cleanup confirmation. If credentials are
missing or any lifecycle stage fails, record `classification: deferred`, owner, exact reason, and next
review date.

- [ ] **Step 3: Run the Cloudflare credential check**

Run: `bun --env-file=.env scripts/smoke-sandbox-cloudflare.ts`

Expected: token/account verification only. Record that this command creates no container and does not
prove lifecycle behavior.

- [ ] **Step 3b: Prove the existing install and smoke paths still reproduce**

Roadmap §9 makes "installation and existing Local/Docker/E2B smoke paths are reproducible" a Phase 0
exit condition, and no task covered it. Run a clean install followed by the Local, Docker, and E2B smoke
paths, and record each command, exit code, version, and timestamp in `phase-0/install-smoke.md`. This is
the regression floor the whole V2 migration is measured against; establishing it after the migration
starts proves nothing.

- [ ] **Step 4: Classify without overstating evidence**

Daytona may be recommended `released-experimental` only when Step 2 proves create/drive/delete. Otherwise
defer it.

Cloudflare must be classified `deferred` from the current smoke because credential verification is not a
lifecycle test. A later task may change that only after adding evidence that creates, drives, and
destroys a real Cloudflare container.

Each evidence file uses these fields:

```text
provider
package version
SDK/CLI version
UTC timestamp
command
capabilities actually proven
redacted result
cleanup result
classification
owner
reason
next review date
```

- [ ] **Step 5: Commit evidence**

```bash
git add docs/evidence/autonomous-local/phase-0/daytona-live.md \
  docs/evidence/autonomous-local/phase-0/cloudflare-live.md
git commit -m "docs: record daytona and cloudflare validation evidence"
```

### Task 5: Complete or defer the Hermes/Discord operator demo

**Files:**

- Modify: `docs/demo/hermes-demo.md` (exists)
- Create: `docs/evidence/autonomous-local/phase-0/hermes-demo.md`

**Interfaces:**

- Produces: either recorded demo evidence or a formal defer record.

- [ ] **Step 1: Run operator preflight**

Run:

```bash
command -v hermes
hermes --version
```

Expected: both commands succeed. If either fails, proceed to Step 3 and record a defer.

- [ ] **Step 2: Attempt the operator-gated demo**

With the operator present, run `hermes gateway restart`. The operator then sends the documented
`docs/demo/hermes-demo.md` message to the configured bot and confirms receipt of progress and final
review. Capture the command, Hermes version, UTC timestamp, redacted request/result, Termbridge session
ID, and whether the final response returned to the same channel.

- [ ] **Step 3: Record evidence or a formal defer**

If the demo runs, store the evidence under `docs/evidence/autonomous-local/phase-0/hermes-demo.md`. If the
operator, bot installation, or Hermes binary is unavailable, record:

```text
classification: deferred
owner: Termbridge maintainer
reason: <one concrete blocking condition>
next_review_date: <YYYY-MM-DD>
```

The defer must not be described as complete.

- [ ] **Step 4: Commit**

```bash
git add docs/demo/hermes-demo.md docs/evidence/autonomous-local/phase-0/hermes-demo.md
git commit -m "docs: record or defer hermes operator demo"
```

### Task 6: OpenCode same-session live spike

**Files:**

- Create: `scripts/spike-opencode-driver.ts`
- Create: `scripts/spike-opencode-driver.test.ts`
- Create: `docs/evidence/autonomous-local/phase-0/opencode-spike.md`

**Interfaces:**

- Produces: a redacted live trace of one OpenCode server + TUI/SDK co-presence session.
- **Blocks Task 8** (the event envelope freeze depends on this evidence).

- [ ] **Step 1: Write the failing probe test**

Use a fake loopback server exposing the version/document endpoint plus an SSE stream. Assert
`probeOpenCodeSurface(baseUrl)` records version, schema hash, native session/event IDs, reconnect cursor,
question ID, permission ID, cancellation, and disconnect.

- [ ] **Step 2: Run the focused test**

Run: `bun test scripts/spike-opencode-driver.test.ts`

Expected: FAIL because `probeOpenCodeSurface` does not exist.

- [ ] **Step 3: Implement the probe and run the live spike**

Implement the HTTP/SSE probe using native `fetch`. Then run:

```bash
TERMBRIDGE_LIVE_OPENCODE=1 bun scripts/spike-opencode-driver.ts \
  --host 127.0.0.1 \
  --port 4096 \
  --output docs/evidence/autonomous-local/phase-0/opencode-spike.md
```

Expected: the script starts `opencode serve`, attaches to one session, exercises Plan→Build,
question/reply, permission/reply, cancellation, SSE disconnect/reconnect, writes a redacted evidence
file, and exits zero. If the installed version lacks a required surface, the script exits nonzero and
the event contract remains unfrozen.

- [ ] **Step 4: Verify the captured interaction surface**

Record: version, schema hash, session IDs, event IDs, SSE cursor/reconnect behavior, `plan_exit` question
request ID, Plan→Build transition, permission request/reply, question reply/reject, cancellation,
disconnect/reconnect, and auth flow. Preserve native IDs.

- [ ] **Step 5: Run the test and redaction scan**

Run:

```bash
bun test scripts/spike-opencode-driver.test.ts
if rg -n '(sk-ant-|ghp_|github_pat_|Bearer [A-Za-z0-9._-]{16,})' \
  docs/evidence/autonomous-local/phase-0/opencode-spike.md; then
  exit 1
fi
```

Expected: test passes and the credential-pattern scan prints no matches.

- [ ] **Step 6: Commit**

```bash
git add scripts/spike-opencode-driver.ts scripts/spike-opencode-driver.test.ts \
  docs/evidence/autonomous-local/phase-0/opencode-spike.md
git commit -m "docs: record opencode same-session spike"
```

### Task 7: Claude Code structured-surface brief

**Files:**

- Create: `docs/evidence/autonomous-local/phase-0/claude-structured-surface.md`

**Interfaces:**

- Produces: a research brief recommending whether the Claude Code driver should use a structured control
  surface or the existing tmux-screen path.
- **Blocks Task 8** (the event envelope and `CodingCliDriver` port depend on this finding).

- [ ] **Step 1: Record installed-binary capabilities**

Run:

```bash
command -v claude
claude --version
claude --help
claude -p --help
```

Expected: record the executable path, exact version, supported noninteractive/structured flags, and exit
codes without recording authentication material.

- [ ] **Step 2: Review first-party documentation**

Review Anthropic's Claude Code overview, CLI reference, hooks, headless/noninteractive, permissions, and
SDK documentation under `https://docs.anthropic.com/en/docs/claude-code/`. Record every exact source URL
and access date. Do not use third-party behavior claims to freeze the contract.

- [ ] **Step 3: Write the brief with an explicit decision rule**

If a structured surface exists and is stable, recommend that Task 14 (driver extraction) use it natively and
document the required launch flags, schema pinning, and compatibility manifest. If no stable structured
surface exists, recommend the existing tmux-screen path as the starting driver and document that decision
with rationale. The brief must cover lifecycle, activity, questions, permissions, cancellation,
authentication, rate limits, session ownership, reconnect/recovery, version/schema stability, and the
fallback fixture version. Missing evidence for any required capability selects the versioned tmux-screen
fallback; it does not invent a structured contract.

- [ ] **Step 4: Verify and commit**

Run:

```bash
rg -n '^## (Installed binary|First-party sources|Capability matrix|Recommendation|Fallback)$' \
  docs/evidence/autonomous-local/phase-0/claude-structured-surface.md
```

Expected: all five required sections are present.

```bash
git add docs/evidence/autonomous-local/phase-0/claude-structured-surface.md
git commit -m "docs: brief claude code structured surface options"
```

### Task 8: Freeze plan, policy, event, and provider port schemas

**Depends on:** Task 6 (OpenCode spike) and Task 7 (Claude structured-surface brief).

**Files:**

- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/tsconfig.build.json`
- Create: `packages/control-plane/src/index.ts`
- Create: `packages/control-plane/src/domain/ids.ts`
- Create: `packages/control-plane/src/domain/task-state.ts`
- Create: `packages/control-plane/src/domain/models.ts`
- Create: `packages/control-plane/src/domain/schemas.ts`
- Create: `packages/control-plane/src/domain/event-envelope.ts`
- Create: `packages/control-plane/src/domain/evidence-schema.ts`
- Create: `packages/control-plane/src/domain/audit-schema.ts`
- Create: `packages/control-plane/src/domain/errors.ts`
- Create: `packages/control-plane/src/ports/cli-driver.ts`
- Create: `packages/control-plane/src/ports/tracker.ts`
- Create: `packages/control-plane/src/ports/forge.ts`
- Create: `packages/control-plane/src/domain/schemas.test.ts`
- Create: `packages/control-plane/src/ports/cli-driver.contract.test.ts`
- Create: `packages/control-plane/src/ports/tracker.contract.test.ts`
- Create: `packages/control-plane/src/ports/forge.contract.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Produces branded `TaskId`, `PlanId`, `OperationId`, `ExternalWorkItemId`, and `CommitSha`.
- Produces `TaskState`, `PlanArtifact`, `Approval`, `ProjectPolicy`, and `DriverEvent`.
- Produces `DurableEvent`, `EventCursor`, `EvidenceRecord`, and `AuditEvent`.
- Produces `CodingCliDriver`, `WorkTrackerAdapter`, and `DraftPullRequestForge`.
- Produces every design §7 payload type (see Step 1), not only the method names.
- Produces a stable error catalog: a closed union of application error codes with stable string
  discriminants, shared by HTTP, MCP, and SDK transports (roadmap §9 Phase 1 deliverable).

- [ ] **Step 1: Write schema and port contract-conformance tests**

Schema tests: assert valid design examples parse, unknown keys fail, `delivery.allow_merge: true` fails,
unsupported drivers fail, and every driver event has a stable discriminant. The design §8 policy key is
snake_case `allow_merge` — asserting on a camelCase `allowMerge` tests a key that never appears in a
policy file. Assert each durable event has
a task ID, per-task monotonic sequence, schema version, timestamp, kind, payload, and previous-event hash.
Assert event cursors reject task/sequence mismatches, evidence is bound to a candidate SHA and artifact
hash, and audit payloads accept redacted references but reject raw secret-bearing fields.

Port contract tests: freeze the exact method signatures from design §7 as conformance suites that any
adapter implementation must pass. Create one contract-test file per port:

- `ports/cli-driver.contract.test.ts`: assert `probe`, `start`, `send`, `observe`, `answer`, `cancel`,
  `recover`, `exportEvidence` exist with the design §7.2 signatures; assert every normalized `DriverEvent`
  kind has a stable discriminant; assert `observe` returns an async iterable.
- `ports/tracker.contract.test.ts`: assert `capabilities`, `verifyWebhook`, `registerOrRenewWebhooks`,
  `reconcile`, `fetchWorkItem`, `fetchContext`, `publishPlan`, `publishProgress`, `publishQuestion`,
  `publishOutcome`, `discoverWorkflow`, `observeCurrentState` exist with the design §7.1 signatures.
- `ports/forge.contract.test.ts`: assert `validateInstallation`, `inspectRepository`, `observeBranch`,
  `observeDraftPullRequest`, `pushCandidate`, `createDraftPullRequest`, `updateDraftPullRequest`,
  `observeChecks` exist with the design §7.3 signatures; assert no `markReady`, `approve`, `merge`,
  `bypassRules`, or `deploy` method exists on the interface (compile-time assertion).

**Freeze the payload types, not only the method names.** A method signature whose parameter and return
types are undefined is not frozen — every adapter task would invent its own shape. Define all of these
as Zod schemas in the matching `ports/*.ts`, and export the inferred types:

- `ports/tracker.ts`: `TrackerCapabilities`, `RawWebhook`, `VerifiedDelivery`, `WebhookRegistration`,
  `TrackerChange`, `NormalizedWorkItem`, `WorkItemContext`, `PublishPlanCommand`,
  `PublishProgressCommand`, `PublishQuestionCommand`, `PublishOutcomeCommand`, `ExternalReference`,
  `WorkflowDescription`, `ExternalState`.
- `ports/cli-driver.ts`: `CliCapabilities`, `StartSession`, `SessionHandle`, `DriverInstruction`,
  `HumanAnswer`, `CancelResult`, `RuntimeBinding`, `RecoveredSession`, `SessionEvidence`.
- `ports/forge.ts`: `RepositoryId`, `ForgeCapabilities`, `RepositoryRules`, `BranchRef`, `BranchState`,
  `DeliveryKey`, `DraftPullRequest`, `PushCandidateCommand`, `BranchResult`,
  `CreateDraftPullRequestCommand`, `UpdateDraftPullRequestCommand`, `PullRequestId`, `CheckSummary`.

**Enumerate the `DriverEvent` union as a closed set**, the same way `TaskState` is enumerated below.
Design §7.2 names exactly ten kinds: `activity`, `question`, `permission_request`, `plan_deviation`,
`idle`, `candidate_ready`, `rate_limit`, `authentication_required`, `failure`, `termination`. Assert the
union has exactly these ten members; a property test over an unspecified set does not freeze anything.

**Define the stable error catalog** in `domain/errors.ts` as a closed union of application error codes
with stable string discriminants. Assert every code is reachable from at least one application command
and that transports serialize codes identically.

Incorporate evidence from the OpenCode spike (Task 6) and Claude brief (Task 7) into the `DriverEvent`
union and `CodingCliDriver` port. Provider packages (Tasks 14–15, 19–20, 22–23) must pass these
contract suites before their own adapter tests.

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/control-plane/src/domain/schemas.test.ts packages/control-plane/src/ports`

Expected: FAIL because the package, schemas, and port contract suites do not exist.

- [ ] **Step 3: Create the package and exact domain unions**

Use this package boundary:

```json
{
  "name": "@termbridge/control-plane",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check ."
  },
  "dependencies": {
    "yaml": "^2.9.0",
    "zod": "^3.24.2"
  }
}
```

Define the approved state union, including:

```ts
export type TaskState =
  | "discovered"
  | "validating"
  | "blocked_configuration"
  | "planning"
  | "awaiting_plan_approval"
  | "plan_rejected"
  | "preparing_workspace"
  | "implementing"
  | "verifying"
  | "automated_review"
  | "repairing"
  | "delivering_draft_pr"
  | "awaiting_github_checks"
  | "draft_pr_ready_for_human"
  | "awaiting_human_input"
  | "replan_required"
  | "paused_budget"
  | "paused_policy"
  | "paused_auth"
  | "paused_uncertain_operation"
  | "canceling"
  | "failed"
  | "canceled";
```

Define no forge methods for ready, approval, merge, bypass, or deploy.

Define the durable envelope independently of transport:

```ts
export interface DurableEvent<TKind extends string, TPayload> {
  eventId: string;
  taskId: TaskId;
  sequence: number;
  schemaVersion: 1;
  occurredAt: string;
  kind: TKind;
  payload: TPayload;
  previousEventHash: string | null;
}

export interface EventCursor {
  taskId: TaskId;
  afterSequence: number;
}
```

`EvidenceRecord` must bind producer, policy version, base SHA, candidate SHA, command/reviewer identity,
result, artifact hashes, and redaction metadata. `AuditEvent` stores actor and action references plus
redacted structured metadata; raw credentials, authorization headers, cookies, and unrestricted
transcripts are not valid schema fields.

Run: `bun install`

Expected: `bun.lock` records `yaml` and the new workspace.

- [ ] **Step 4: Verify package boundaries**

Run: `bun test packages/control-plane && bun run typecheck`

Expected: PASS; `rg '@termbridge/(server|tracker-|forge-|driver-)' packages/control-plane/src` returns no
imports.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane bun.lock
git commit -m "feat: define autonomous control plane contracts"
```

**Phase 0 gate** — run `bun scripts/gate-check.ts --phase 0`. Every criterion below is a check that
script performs; none of them is a matter of review opinion:

1. Every Phase 0 task checkbox is checked, including Tasks 2A, 2B, and 2C — zero unchecked `- [ ]`
   within the Phase 0 task blocks.
2. V2 docs are committed — the six authority paths from Task 0 are tracked.
3. Generated truth is clean — `bun run status:check` exits zero with no tracked-file drift.
4. ADRs accepted — `rg -c '^## V2-D([1-9]|1[0-7]) ' docs/DECISIONS.md` equals 17, and the record
   superseding legacy D3 with V2-D2 is present. There is no D5–D8 to supersede.
5. ARCHITECTURE.md reflects V2 — `rg -n '^## (Packages|Layering|Control plane|Drivers|Trackers|Forge)$'
   docs/ARCHITECTURE.md` matches every required section, the same shape as Task 7's brief check.
6. Benchmark truth — `bun test benchmarks/autonomous-local/manifest.schema.test.ts` passes, which
   rejects fewer than four pinned licensed fixtures, fewer than 20 authored cases, any missing
   `critical_scenario` from the 18 named in roadmap §10, non-40-character SHAs, missing SPDX
   identifiers, missing SHA-256 hashes, and unpinned image tags.
7. Sandbox classification — `phase-0/daytona-live.md` and `phase-0/cloudflare-live.md` exist and each
   records classification, owner, reason, and next review date.
8. Hermes evidence — `phase-0/hermes-demo.md` exists and records either a live run or a formal defer.
9. Spike evidence — `phase-0/opencode-spike.md` and `phase-0/claude-structured-surface.md` exist, and
   the frozen `DriverEvent` schema hash equals the hash recorded in the OpenCode spike. "Incorporated"
   is otherwise unfalsifiable.
10. Threat model — `docs/security/threat-model.md` exists with all seven required surfaces (Task 2C).
11. Installability — `phase-0/install-smoke.md` records reproducible Local, Docker, and E2B smoke runs
    with command, exit code, and timestamp (roadmap §9 Phase 0 exit condition).
12. The existing suite remains green — `bun run lint && bun run typecheck && bun test` exits zero.

---

## Phase 1 — Durable Local control plane

### Task 9: Implement the task transition engine and approval invalidation

**Depends on:** Task 8 — writes into the package Task 8 scaffolds and consumes `TaskState`,
`PlanArtifact`, `Approval`, and `ProjectPolicy`.

**Files:**

- Create: `packages/control-plane/src/domain/transitions.ts`
- Create: `packages/control-plane/src/domain/transitions.test.ts`
- Create: `packages/control-plane/src/domain/approval.ts`
- Create: `packages/control-plane/src/domain/approval.test.ts`

**Interfaces:**

- Consumes: `TaskState`, `PlanArtifact`, `Approval`, `ProjectPolicy`.
- Produces: `transitionTask(input: TransitionInput): TransitionResult`.
- Produces: `validateApproval(input: ApprovalValidationInput): ApprovalValidation`.

- [ ] **Step 1: Write transition-table tests**

Cover every allowed edge, representative forbidden edges, all success invariants, and every approval
invalidation cause. Generate transition sequences and assert implementation never occurs without valid
approval. "Every" is enumerated below — do not leave the sets implicit.

**The 17 forward edges (design §5), with their guards:**

```text
DISCOVERED             → VALIDATING
VALIDATING             → BLOCKED_CONFIGURATION
VALIDATING             → PLANNING
PLANNING               → AWAITING_PLAN_APPROVAL
AWAITING_PLAN_APPROVAL → PLAN_REJECTED
AWAITING_PLAN_APPROVAL → PREPARING_WORKSPACE      guard: approved plan hash
PLAN_REJECTED          → PLANNING                 guard: human feedback recorded
PREPARING_WORKSPACE    → IMPLEMENTING
IMPLEMENTING           → VERIFYING
VERIFYING              → AUTOMATED_REVIEW         guard: tests pass
VERIFYING              → REPAIRING                guard: verification failure
AUTOMATED_REVIEW       → DELIVERING_DRAFT_PR      guard: review passes
AUTOMATED_REVIEW       → REPAIRING                guard: blocking findings
REPAIRING              → IMPLEMENTING
DELIVERING_DRAFT_PR    → AWAITING_GITHUB_CHECKS
AWAITING_GITHUB_CHECKS → DRAFT_PR_READY_FOR_HUMAN guard: required checks pass
AWAITING_GITHUB_CHECKS → REPAIRING                guard: failed checks
```

Plus the pause fan-out: every active state may enter `AWAITING_HUMAN_INPUT`, `REPLAN_REQUIRED`,
`PAUSED_BUDGET`, `PAUSED_POLICY`, `PAUSED_AUTH`, `PAUSED_UNCERTAIN_OPERATION`, `CANCELING`, `FAILED`,
or `CANCELED`; `CANCELING → CANCELED` is terminal; external branch modification pauses from
`AWAITING_GITHUB_CHECKS`.

**The 9 success invariants** required before `DRAFT_PR_READY_FOR_HUMAN` (design §5.3) — one assertion
each: PR is open and draft; PR head SHA equals the verified SHA; PR head SHA equals the reviewed SHA
when review is required; approved plan and policy remain current; required local verification passed;
required GitHub checks passed; no blocking review findings remain; tracker and PR links are
synchronized; the evidence bundle is complete and secret-free.

**The 9 approval-invalidation causes** (design §5.4) — one assertion each: material issue changes;
repository or base changes; stale base beyond policy; plan changes; policy changes; selected driver
changes; required reviewer changes; security classification changes; expiration.

**Two open questions the design does not answer.** Resolve both here and record the answer in the ADR
rather than guessing per-call-site:
1. `design:383` says "any *applicable* active state" may pause, but never defines which paused states
   are reachable from which active states — e.g. whether `DISCOVERED` can enter `PAUSED_BUDGET`.
2. `design:395` says resume is "an explicit audited transition" but never names the target state.

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/control-plane/src/domain/transitions.test.ts packages/control-plane/src/domain/approval.test.ts`

Expected: FAIL because transition functions do not exist.

- [ ] **Step 3: Implement a total transition table**

Use an explicit `Record<TaskState, readonly TaskState[]>` populated from the enumerated edge list in
Step 1; do not encode transition policy as scattered conditionals. Return stable error codes from the
Task 8 error catalog for forbidden edge, stale state version, invalid approval, stale evidence, and
terminal state.

- [ ] **Step 4: Verify**

Run: `bun test packages/control-plane/src/domain && bun run typecheck`

Expected: PASS with all 23 states represented in the transition table, all 17 forward edges and 4 named
guards present, and one assertion per success invariant and per invalidation cause.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/domain
git commit -m "feat: add durable task transition rules"
```

### Task 10: Add SQLite schema, migrations, and repository conformance

**Depends on:** Tasks 8 and 9 — needs `AuditEvent` from Task 8 and `transitionTask` from Task 9 for the
atomic transition-plus-audit test.

**Files:**

- Create: `packages/control-plane/src/storage/repositories.ts`
- Create: `packages/control-plane/src/storage/conformance.ts`
- Create: `packages/control-plane/src/storage/sqlite/database.ts`
- Create: `packages/control-plane/src/storage/sqlite/migrations.ts`
- Create: `packages/control-plane/src/storage/sqlite/migrations/0001_initial.sql`
- Create: `packages/control-plane/src/storage/sqlite/migrations-ledger.ts`
- Create: `packages/control-plane/src/storage/sqlite/repositories.ts`
- Create: `packages/control-plane/src/storage/sqlite/repositories.test.ts`
- Create: `packages/control-plane/src/storage/sqlite/migrations.test.ts`
- Create: `packages/control-plane/src/storage/sqlite/lease-fence.test.ts`

**Interfaces:**

- Produces: `ControlPlaneRepositories`.
- Produces: `openControlPlaneDatabase(path: string): ControlPlaneDatabase`.
- Produces: `migrateDatabase(db): MigrationResult`.
- Produces: `runRepositoryConformance(createHarness): void`.

- [ ] **Step 1: Write real-SQLite conformance tests**

Cover atomic transition plus audit append, unique webhook receipt, unique active task, immutable approval,
CAS failure, lease acquisition/expiry, operation uniqueness, foreign keys, backup/restore, and migration
from an empty file.

**Lease fencing tests (required by research §3, L158–L198):** assert a `fencing_token` column exists on
the lease table and is monotonically increasing per resource; assert a stale worker (expired lease) cannot
advance task state because its `WHERE lease_id = ? AND fencing_token = ?` update returns zero rows; assert
a delayed worker that wakes after lease expiry is rejected on every durable mutation (task transition,
operation append, event append, worktree ref update).

- [ ] **Step 2: Run tests**

Run: `bun test packages/control-plane/src/storage/sqlite`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement SQLite initialization and the full initial schema**

Use `bun:sqlite`; set WAL, foreign keys, busy timeout, and explicit transactions on every opened
connection. Store timestamps as UTC text and hashes/IDs as text. Never store secret values.

`0001_initial.sql` must create all 18 design §6 tables in dependency order:

1. `tracker_installations`, `github_installations`, `webhook_receipts`
2. `projects`, `repository_bindings`, `status_mappings`, `external_work_items`, `task_runs`, `plans`,
   `approvals`
3. `workspaces`, `runtime_sessions`, `verification_runs`, `review_runs`, `review_findings`,
   `deliveries`, `external_operations`, `audit_events`

Plus three infrastructure tables the design does not enumerate:

- `task_events` — the durable event store Task 12A reads and writes. Columns: `task_id`, `sequence`
  (per-task monotonic integer), `event_id`, `kind`, `schema_version`, `payload`, `previous_event_hash`,
  `created_at`. Constraints: `UNIQUE (task_id, sequence)` and `UNIQUE (event_id)`. Without this table
  Task 12A has nothing to append to; it adds no migration of its own.
- `lease` — `resource`, `holder`, `expires_at` (database time), `fencing_token` (monotonically
  increasing integer), `state_version`.
- `schema_migrations` — version, checksum, applied_at, rollback availability.

Declare `lease_id` and `fencing_token` columns explicitly on every table that Step 4 fences:
`task_runs`, `external_operations`, `task_events`, and `workspaces`. A `WHERE` clause cannot reference
a column the schema never creates.

- [ ] **Step 4: Implement migration ledger and repositories**

`migrations-ledger.ts` records each migration's version, SHA-256 checksum, applied timestamp, and whether
a down-migration exists. Atomic failure behavior: a migration that errors leaves the database at the prior
version with no partial schema. Upgrade fixtures test migration from an empty file, from the previous
version, and idempotent re-application.

Support a **dry-run mode** that reports the migrations that would apply, the resulting schema version,
and any incompatibility, without mutating the database. Roadmap §12 requires migration dry-runs and
schema-compatibility evidence before every release; a ledger alone does not provide it.

Make task transition, state-version increment, operation append, lease fence check, audit append, and
**event append** one transaction. Task 12A L1095 requires the transition, the audit record, and the
emitted events to commit together or not at all. Map database rows into domain records at the adapter boundary. Every durable mutation that
advances a task MUST include `WHERE lease_id = ? AND fencing_token = ?`; a zero-row update means ownership
was lost and the mutation is rejected.

- [ ] **Step 5: Verify**

Run: `bun test packages/control-plane/src/storage && bun run typecheck`

Expected: PASS against temporary on-disk databases, not only `:memory:`.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/storage
git commit -m "feat: persist autonomous tasks in sqlite"
```

### Task 11: Implement operation journal, leases, scheduler, and startup reconciliation

**Depends on:** Tasks 8 and 10 — the lease-fence tests require the `lease` table and `fencing_token`
column created by Task 10 Step 3.

**Files:**

- Create: `packages/control-plane/src/application/operation-journal.ts`
- Create: `packages/control-plane/src/application/operation-journal.test.ts`
- Create: `packages/control-plane/src/application/scheduler.ts`
- Create: `packages/control-plane/src/application/scheduler.test.ts`
- Create: `packages/control-plane/src/application/reconcile.ts`
- Create: `packages/control-plane/src/application/reconcile.test.ts`
- Create: `packages/control-plane/src/ports/runtime.ts`

**Interfaces:**

- Produces: `executeJournaledOperation<T>(spec: JournaledOperation<T>): Promise<T>`.
- Produces: `claimRunnableTask(now: Instant): Promise<TaskLease | null>`.
- Produces: `reconcileOnStartup(input: ReconcileInput): Promise<ReconcileReport>`.
- Produces: tmux metadata tags (`@termbridge.session_id`, `@termbridge.task_id`,
  `@termbridge.binding_generation`, `@termbridge.environment_id`) written on session creation and
  inventoried on startup (required by research §2, L136–L156).

- [ ] **Step 1: Write boundary crash and tmux-tag reconciliation tests**

Test kill/failure before durable prepare, after prepare, after dispatch, after provider effect before
confirmation, during inspect, and after confirmation. Assert only safe retry, confirmed reconciliation,
or explicit uncertain pause.

Tmux tag tests: assert session creation writes all four `@termbridge.*` user options; assert startup
inventory reads them and matches against durable `runtime_sessions`; assert the full reconciliation matrix
from research §2 (exact binding + safe checkpoint → reattach; exact binding + dispatched op → paused;
no binding → lost; multiple/generation mismatch → conflict quarantine; terminal + live → orphan preserve;
no durable record → unknown, never adopt).

Stale-worker fencing tests: assert a worker whose lease has expired cannot advance task state because its
fencing token no longer matches; assert a delayed worker that reconnects after expiry is rejected on each
of the four fenced durable mutations — task transition, operation append, event append, and worktree
reference update — not only task transitions.

Retention tests: assert event retention prunes `task_events` beyond the configured window and that a
cursor predating retained history returns `stream.gap` rather than silently resuming.

- [ ] **Step 2: Run tests**

Run: `bun test packages/control-plane/src/application/operation-journal.test.ts packages/control-plane/src/application/reconcile.test.ts`

Expected: FAIL because application services do not exist.

- [ ] **Step 3: Implement the journal executor**

Require deterministic operation key, request hash, `dispatch`, and `inspect`. A reused key with a
different hash returns `operation_payload_conflict`.

- [ ] **Step 4: Implement leases, tmux tagging, and startup reconciliation**

Use database timestamps and state versions. Implement event retention pruning driven by the project
policy's `retention.evidence_days`, preserving the `stream.gap` contract for cursors that predate the
retained window. On session creation, write the four `@termbridge.*` tmux user options and persist the
tmux socket/session ID/name in `runtime_sessions`. Treat tmux/runtime
matches as observed bindings only — match on the durable binding generation, not on tmux name. Never
adopt unknown sessions. Every durable mutation includes the lease fence check.

- [ ] **Step 5: Verify**

Run: `bun test packages/control-plane/src/application && bun run typecheck`

Expected: PASS with zero replay of dispatched terminal or external mutations.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/application packages/control-plane/src/ports/runtime.ts
git commit -m "feat: add journaled scheduling and recovery"
```

### Task 12A: Implement durable events, HTTP/SSE commands, MCP parity, SDK, redaction canary, and environment conformance

**Depends on:** Tasks 9–11, plus Task 4 — environment conformance runs against "each non-deferred
provider", and Task 4 decides which providers are deferred.

**Files:**

- Create: `packages/control-plane/src/events/event-store.ts`
- Create: `packages/control-plane/src/events/event-store.test.ts`
- Create: `packages/control-plane/src/application/command-service.ts`
- Create: `packages/control-plane/src/application/command-service.test.ts`
- Create: `packages/control-plane/src/redaction/canary-corpus.ts`
- Create: `packages/control-plane/src/redaction/canary-corpus.test.ts`
- Create: `packages/control-plane/src/testing/env-conformance.ts`
- Create: `packages/control-plane/src/testing/env-conformance.test.ts`
- Create: `packages/server/src/ws-authorization.test.ts`
- Create: `packages/server/src/routes/v2-tasks.ts`
- Create: `packages/server/src/routes/v2-events.ts`
- Create: `packages/server/src/events-sse.test.ts`
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/src/index.ts`
- Create: `packages/sdk/src/generated/` (generated from shared schemas)
- Create: `packages/sdk/src/sdk.test.ts`
- Create: `packages/mcp-server/src/application-adapter.ts`
- Create: `packages/mcp-server/src/application-adapter.test.ts`
- Create: `packages/mcp-server/src/golden/` (one fixture per legacy tool)
- Create: `packages/mcp-server/src/golden/golden-parity.test.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/mcp-server/package.json`
- Modify: `bun.lock`

**Interfaces:**

- Produces `EventStore.append`, `readTaskEvents`, and `subscribeTaskEvents`.
- Produces typed command handlers shared by HTTP, MCP, and SDK transports.
- Produces `GET /api/v2/tasks/:taskId/events` as resumable SSE using a durable sequence cursor.
- Produces `@termbridge/sdk` generated from the shared command schemas with HTTP transport parity.
- Preserves the existing 13 MCP tool contracts through golden fixtures and a compatibility adapter.
- Produces a shared redaction canary corpus usable by every later redaction/egress test.
- Produces a backend-neutral environment-conformance suite run against Local, Docker, and E2B.
- Preserves both existing MCP transports — stdio and Streamable HTTP — and states that support
  explicitly, since roadmap §12 requires keeping both within the compatibility window.
- Keeps WebSocket scoped to live terminal bytes and interactive browser attachment per V2-D3. SSE
  carries application events; WebSocket carries no application event traffic and is never an
  alternative task-state source.

- [ ] **Step 1: Write durable event-store tests**

Use a temporary on-disk SQLite database. Assert transactionally appended events have gap-free,
monotonic per-task sequences; survive process/database reopen; reject duplicate event IDs and stale
expected sequences; preserve previous-event hashes; and return an explicit `stream.gap` response when a
requested cursor predates retained history.

- [ ] **Step 2: Run the focused event test**

Run: `bun test packages/control-plane/src/events/event-store.test.ts`

Expected: FAIL because the event store does not exist.

- [ ] **Step 3: Write the redaction canary corpus**

Create `canary-corpus.ts` exporting a versioned array of canary secrets (exact, base64, URL-encoded,
split-across-chunks, JSON field, URL, environment variable, ANSI terminal, structured object, error
stack) and the surfaces they must not appear in (SQLite rows, logs, events, SSE frames, browser
responses, audit details, diagnostic archives). Every later redaction/egress test consumes this corpus.
This is the shared corpus the roadmap requires in Phase 1 (not deferred to Phase 3).

- [ ] **Step 4: Write HTTP/SSE, SDK, and MCP golden-parity tests**

Assert HTTP commands, SDK calls, and all legacy MCP tools call the same application command service and
produce the same state transition, durable event kinds, stable error codes, and redacted evidence
references for equivalent inputs. Assert SSE reconnect with `Last-Event-ID` resumes after the
acknowledged sequence, never repeats acknowledged events, and emits `stream.gap` before closing when
exact replay is impossible.

MCP golden fixtures: create `packages/mcp-server/src/golden/` with one versioned JSON fixture per
legacy tool (13 files) recording tool name, argument schema, request sample, response shape, and
documented behavior. The golden-parity test loads all 13 fixtures and asserts the compatibility adapter
preserves names, schemas, and response shapes exactly.

SDK parity: `packages/sdk` is generated from the same shared Zod schemas as the HTTP routes. The SDK
test asserts equivalent inputs through the SDK and HTTP produce equivalent application results and
errors without an SDK-to-HTTP network hop when used in-process.

MCP transport support: assert both stdio and Streamable HTTP still serve the compatibility adapter.
Roadmap §12 keeps both inside the support window; dropping either silently breaks existing callers.

WebSocket boundary (`ws-authorization.test.ts`): V2-D3 reserves WebSocket for live terminal bytes and
interactive browser attachment, and the V1 server already ships WS routes. Assert exact-match `Origin`
validation, per-message authorization against the session's durable task binding, rejection of
unauthenticated upgrades, and that **no application event is delivered over WebSocket** — SSE is the
only application event transport, so a WS client cannot observe or influence task state.

- [ ] **Step 5: Run the focused transport tests**

Run:

```bash
bun test packages/server/src/events-sse.test.ts \
  packages/server/src/ws-authorization.test.ts \
  packages/mcp-server/src/application-adapter.test.ts \
  packages/mcp-server/src/golden/golden-parity.test.ts \
  packages/sdk/src/sdk.test.ts
```

Expected: FAIL because the routes, compatibility adapter, SDK, and golden fixtures do not exist.

- [ ] **Step 6: Write environment-conformance tests**

Create `env-conformance.ts` as a backend-neutral suite asserting lifecycle invariants across
`LocalEnvironment`, `DockerEnvironment`, and `E2BEnvironment`: create, start, send text, capture output,
resize, kill, and reconcile. The suite is parameterized by an environment factory and must pass against
each non-deferred provider. This is the roadmap's Phase 1 environment-conformance requirement.

- [ ] **Step 7: Implement one application service, thin transports, SDK, and golden adapter**

Persist the state transition, audit record, and emitted events in one repository transaction. HTTP, SDK,
and MCP validate and translate transport inputs only; neither contains orchestration rules. Encode the SSE
event ID as an opaque, signed task-and-sequence cursor. Do not use an in-memory event emitter as the
source of truth. Generate the SDK from the shared schemas (code generation script or hand-maintained
typed client — either is acceptable as long as parity is tested).

- [ ] **Step 8: Verify restart, cursor, compatibility, SDK, canary, and environment behavior**

Run:

```bash
bun test packages/control-plane/src/events \
  packages/control-plane/src/application/command-service.test.ts \
  packages/control-plane/src/redaction/canary-corpus.test.ts \
  packages/control-plane/src/testing/env-conformance.test.ts \
  packages/server/src/events-sse.test.ts \
  packages/mcp-server/src/application-adapter.test.ts \
  packages/mcp-server/src/golden/golden-parity.test.ts \
  packages/sdk/src/sdk.test.ts
bun run typecheck
```

Expected: PASS after closing and reopening SQLite between publish and resume; the golden test covers all
13 existing MCP tools; SDK and HTTP produce equivalent results; the canary corpus is absent from each of
the 13 surfaces enumerated in Step 3; environment conformance passes against Local, Docker, and E2B.

- [ ] **Step 9: Record the Phase 1 gate evidence**

Create `docs/evidence/autonomous-local/phase-1/gate.md` with, per gate criterion, the command run, its
exit code, the Git SHA, the timestamp, and the artifact path. Include the reviewer sign-off field that
the Phase 1 gate requires before live provider work begins. Step 10's `git add` targets this directory;
without this step the commit fails on a nonexistent path.

- [ ] **Step 10: Commit**

```bash
git add packages/control-plane/src/events \
  packages/control-plane/src/application/command-service.ts \
  packages/control-plane/src/application/command-service.test.ts \
  packages/control-plane/src/redaction \
  packages/control-plane/src/testing/env-conformance.ts \
  packages/control-plane/src/testing/env-conformance.test.ts \
  packages/sdk \
  packages/server/src/routes/v2-tasks.ts packages/server/src/routes/v2-events.ts \
  packages/server/src/events-sse.test.ts packages/server/src/server.ts packages/server/package.json \
  packages/mcp-server/src/application-adapter.ts packages/mcp-server/src/application-adapter.test.ts \
  packages/mcp-server/src/golden \
  packages/mcp-server/package.json bun.lock \
  docs/evidence/autonomous-local/phase-1
git commit -m "feat: add durable events and transport parity"
```

### Task 12B: Build fake adapters and the first full tracer

**Depends on:** Task 12A.

**Files:**

- Create: `packages/control-plane/src/testing/fake-cli.ts`
- Create: `packages/control-plane/src/testing/fake-tracker.ts`
- Create: `packages/control-plane/src/testing/fake-forge.ts`
- Create: `packages/control-plane/src/application/task-service.ts`
- Create: `packages/control-plane/src/application/task-service.test.ts`
- Create: `packages/control-plane/src/e2e/synthetic-tracer.test.ts`

**Interfaces:**

- Produces: `TaskService.discover`, `plan`, `approve`, `runNext`, `answer`, `cancel`, `reconcile`.
- Produces controllable fake adapters with delivery histories and injected faults.

- [ ] **Step 1: Write the synthetic tracer**

Drive discovered → plan → approval → implementation → failed verification → repair → blocking review →
repair → draft delivery → failed check → repair → success. Crash the service at each operation boundary.

- [ ] **Step 2: Run the tracer**

Run: `bun test packages/control-plane/src/e2e/synthetic-tracer.test.ts`

Expected: FAIL because `TaskService` and fakes do not exist.

- [ ] **Step 3: Implement the smallest orchestration service**

Application services issue typed commands and persist every transition. Do not call provider or runtime
methods outside the operation-journal executor.

- [ ] **Step 4: Verify**

Run: `bun test packages/control-plane && bun run typecheck`

Expected: PASS with exactly one task, branch, fake PR, and terminal success record.

- [ ] **Step 5: Record Phase 1 evidence and commit**

```bash
git add packages/control-plane docs/evidence/autonomous-local/phase-1
git commit -m "feat: complete durable autonomous tracer"
```

**Phase 1 gate** — run `bun scripts/gate-check.ts --phase 1`:

1. Synthetic end-to-end and crash matrix pass — `bun test packages/control-plane/src/e2e`.
2. **SQLite backup/restore conformance passes** — Task 10's storage-level backup/restore test. The
   `scripts/backup-local.ts` and `restore-local.ts` CLIs do not exist until Task 25; a gate cannot
   require tooling from four phases later.
3. Durable event replay and SSE cursor/gap behavior survive restart — the event-store and SSE tests
   pass after closing and reopening the database.
4. All 13 legacy MCP tools pass golden fixture parity — `golden-parity.test.ts` loads all 13 fixtures.
5. SDK and HTTP produce equivalent results — `packages/sdk/src/sdk.test.ts`.
6. Both MCP transports still serve the adapter — stdio and Streamable HTTP.
7. The WebSocket boundary holds — `ws-authorization.test.ts`: Origin validation, per-message
   authorization, and no application event delivered over WebSocket.
8. The canary corpus is absent from each of the **13 surfaces enumerated in Task 12A Step 3**: SQLite
   rows, logs, events, SSE frames, browser responses, audit details, and diagnostic archives, across
   exact, base64, URL-encoded, split-chunk, and structured-object encodings. Full-egress coverage is a
   Phase 3 criterion, since the streaming redactor does not exist yet.
9. Environment conformance passes against Local, Docker, and E2B. E2B requires `E2B_API_KEY`; absent
   the key the run **fails** the gate rather than skipping — record the credential requirement in the
   gate evidence.
10. tmux metadata tags are written and inventoried — the four `@termbridge.*` options assert on
    creation and startup inventory.
11. Stale-worker fencing rejects **each of the four fenced durable mutations** after lease expiry:
    task transition, operation append, event append, and worktree reference update.
12. `docs/evidence/autonomous-local/phase-1/gate.md` exists, validates, and carries the reviewer
    sign-off field. Live provider work does not begin until that field is filled.

---

## Phase 2 — Workspaces and CLI drivers

### Task 13: Implement deterministic repository mirrors and locked worktrees

**Depends on:** Task 8 — creates `packages/control-plane/src/workspace/**` inside the package Task 8
scaffolds.

**Files:**

- Create: `packages/control-plane/src/workspace/git.ts`
- Create: `packages/control-plane/src/workspace/worktree-manager.ts`
- Create: `packages/control-plane/src/workspace/worktree-manager.test.ts`
- Create: `packages/control-plane/src/workspace/path-policy.ts`
- Create: `packages/control-plane/src/workspace/path-policy.test.ts`

**Interfaces:**

- Produces: `WorktreeManager.prepare(spec): Promise<PreparedWorkspace>`.
- Produces: `freeze(workspace): Promise<FrozenCandidate>`.
- Produces: `preserve`, `cleanup`, and `reconcile`, driven by the policy's `retention` block.
- `cleanup` honors `retention.successful_worktree_days` and `retention.failed_worktree_days`; a paused
  task preserves its worktree and evidence regardless of age, per design §5.4. Retention is a policy
  input, not a hard-coded constant — without it, dirty worktrees accumulate until the disk fills.

- [ ] **Step 1: Write tests using real temporary Git repositories**

Cover deterministic path/ref, immutable base SHA, lock, collision, dirty preservation, symlink escape,
disabled hooks, external ref modification, expected-old-OID updates, and idempotent reconciliation.

- [ ] **Step 2: Run tests**

Run: `bun test packages/control-plane/src/workspace`

Expected: FAIL because the workspace manager does not exist.

- [ ] **Step 3: Implement Git through argument arrays**

Never build shell command strings. Set isolated Git config, disable hooks, validate canonical paths, and
record observed OIDs before mutation.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/control-plane/src/workspace && bun run typecheck`

```bash
git add packages/control-plane/src/workspace
git commit -m "feat: manage isolated task worktrees"
```

### Task 14: Extract the Claude Code driver and remove in-session GitHub delivery

**Depends on:** Task 8 (the `CodingCliDriver` port it implements), Task 2A (which edits the same
`auth/provisioner.ts` and `engineer-loop.test.ts` this task moves), Task 7 (Claude structured-surface
brief), and Task 13 (managed worktrees) — the driver
uses the brief's recommended surface and the live tracer uses the workspace boundary.

**Files:**

- Create: `packages/driver-claude/package.json`
- Create: `packages/driver-claude/tsconfig.json`
- Create: `packages/driver-claude/src/index.ts`
- Create: `packages/driver-claude/src/driver.ts`
- Create: `packages/driver-claude/src/driver.test.ts`
- Create: `packages/driver-claude/src/e2e.live.test.ts`
- Create: `packages/driver-claude/src/fixtures/compatibility.json`
- Create: `docs/evidence/autonomous-local/phase-2/claude-candidate-tracer.md`
- Modify: `packages/core/src/manager.ts`
- Modify: `packages/core/src/index.ts`
- Move: `packages/core/src/auth/provisioner.ts` → `packages/driver-claude/src/auth-provisioner.ts`
- Move: `packages/core/src/auth/provisioner.test.ts` → `packages/driver-claude/src/auth-provisioner.test.ts`
- Modify: `packages/core/src/auth/` (remove the moved files; Core no longer references AuthProvisioner)
- Modify: `packages/orchestrator/src/engineer-loop.ts`
- Modify: `packages/orchestrator/src/types.ts`
- Modify: `packages/orchestrator/src/delivery.ts`
- Modify: `bun.lock`

**Interfaces:**

- Implements: `CodingCliDriver`.
- Preserves: existing `runEngineerLoop` public API during migration, but marks delivery options deprecated.

- [ ] **Step 1: Write driver lifecycle tests around a scripted tmux/runtime port**

Cover startup, folder trust, activity, questions, permissions, cancellation, rate limit, authentication,
candidate ready, malformed output, daemon recovery, and transcript redaction. If Task 7 recommended a
structured surface, test against that surface; otherwise test the tmux-screen path.

- [ ] **Step 2: Write regression tests proving GitHub variables are not forwarded**

Assert `GH_TOKEN` and `GH_HOST` are absent unless an explicit non-delivery user allowlist includes them.
Assert the new Autonomous Local path never calls `resolveDelivery`.

**Task-specific runtime home and minimal CLI auth (roadmap Phase 2 deliverable):** assert the driver
launches Claude Code with a task-specific `HOME` directory (not the host user's home) containing only the
minimal Claude credential material and no tracker/GitHub control-plane credentials. Assert the
`AuthProvisioner` injected from `driver-claude` points HOME at an isolated credentials volume scoped to
the task. Assert Jira, Linear, and GitHub App credentials are not present in the task runtime
environment.

**First-run Local-versus-Docker trust choice (roadmap Phase 2 deliverable):** assert the composition root
presents an explicit trust choice on first run: Local host execution (no isolation) or Docker (strong
isolation), with the trust consequence shown before Local host execution is permitted. Assert untrusted
work is steered to Docker by default and that the choice is persisted in project policy.

**Post-plan sensitive-effect gate (roadmap Phase 2 deliverable):** assert that after plan approval, the
driver permits routine scoped edits and tests but gates credentials, destructive commands (`rm -rf`,
`DROP TABLE`, force-push), persistent permission grants, and equivalent sensitive effects behind
explicit Termbridge policy. Assert a Claude Code `acceptForSession` or OpenCode `always` response does
not broaden the user's Termbridge grant.

- [ ] **Step 3: Implement the driver, move Claude auth out of Core, and compatibility shim**

Move `packages/core/src/auth/provisioner.ts` and its test into `packages/driver-claude/src/`. The
`AuthProvisioner` (which points HOME at a Claude credentials volume) is Claude-specific and must not
remain in the provider-neutral Core package. Update `packages/core/src/manager.ts` to stop instantiating
`AuthProvisioner` directly; instead accept an optional `authProvisioner` parameter injected by the
composition root (server) using the driver package. Remove the automatic `GH_TOKEN`/`GH_HOST` forwarding
from `SessionManager.sessionEnv` (L345) — the new Autonomous Local path never forwards forge credentials;
the legacy `runEngineerLoop` path keeps them only behind an explicit non-delivery allowlist.

Move Claude recognizer registration and authentication policy behind the driver. Translate native/screen
events into the normalized driver union. Keep old orchestrator tests green through an adapter shim.
Run `bun install` after adding the workspace package.

- [ ] **Step 4: Run deterministic verification**

Run: `bun test packages/driver-claude packages/core packages/orchestrator && bun run typecheck`

Expected: PASS; new application path has no in-session branch/push/PR behavior.

- [ ] **Step 5: Run the gated real candidate-workspace tracer**

Run:

```bash
TERMBRIDGE_LIVE_CLAUDE=1 \
  bun test packages/driver-claude/src/e2e.live.test.ts
```

Expected: the configured Claude Code binary plans and implements an approved fixture task inside a
managed worktree, returns a frozen candidate SHA, and leaves the base checkout and remote unchanged.
The tracer injects no tracker or GitHub credentials and records binary version, driver mode, base SHA,
candidate SHA, event schema version, and redacted transcript/evidence hashes under
`docs/evidence/autonomous-local/phase-2/claude-candidate-tracer.md`. Skipping this command does not satisfy
the Phase 2 gate.

- [ ] **Step 6: Commit**

```bash
git add packages/driver-claude packages/core/src packages/orchestrator/src bun.lock \
  docs/evidence/autonomous-local/phase-2/claude-candidate-tracer.md
git commit -m "feat: extract claude code driver"
```

### Task 15: Implement the OpenCode native driver

**Depends on:** Task 8 (the `CodingCliDriver` port it implements), Task 6 (OpenCode spike trace), and
Task 13 (managed worktrees) — consume the recorded
protocol evidence; the completed driver must still run its own real candidate-workspace tracer.

**Files:**

- Create: `packages/driver-opencode/package.json`
- Create: `packages/driver-opencode/tsconfig.json`
- Create: `packages/driver-opencode/src/index.ts`
- Create: `packages/driver-opencode/src/client.ts`
- Create: `packages/driver-opencode/src/driver.ts`
- Create: `packages/driver-opencode/src/driver.test.ts`
- Create: `packages/driver-opencode/src/e2e.live.test.ts`
- Create: `packages/driver-opencode/src/fixtures/compatibility.json`
- Create: `docs/evidence/autonomous-local/phase-2/opencode-candidate-tracer.md`
- Modify: `bun.lock`

**Interfaces:**

- Implements: `CodingCliDriver`.
- Consumes: OpenCode loopback HTTP/OpenAPI/SSE server.

- [ ] **Step 1: Consume the Phase 0 OpenCode spike trace**

Read `docs/evidence/autonomous-local/phase-0/opencode-spike.md`. Extract the verified version, schema hash,
session/event ID shapes, `plan_exit` question request ID, and SSE cursor behavior. Re-run the protocol
spike only if the installed OpenCode version or published schema hash differs.

- [ ] **Step 2: Write contract tests against a fake OpenCode server**

Cover all normalized driver events, SSE reconnect/cursor behavior, unknown schema fail-closed behavior,
and outer read-only planning.

**OpenCode Plan-mode bash denial (required by research §3, L231–L245 and L406–L415):** assert the driver
selects the native `plan` agent AND applies an effective permission override that denies `bash` and other
mutation tools during planning AND enforces an outer read-only worktree boundary until approval. Assert
that a bash command issued during Plan mode is rejected by the driver's permission policy, not merely by
the worktree being read-only. Assert the `plan_exit` question is mapped to `plan_approval` and that a Yes
reply transitions to Build with bash re-enabled and the worktree made writable.

**Credential containment (Phase 2 and Phase 4A gate criterion):** assert the OpenCode runtime
environment contains no `GH_TOKEN`, no `GH_HOST`, and no Jira, Linear, or GitHub App credential, and
that the driver launches with a task-specific `HOME` rather than the host user's. Task 14 asserts this
for Claude Code; without the matching assertion here, the gate's "credentials remain outside runtimes"
is only half tested and the untested half is the newer driver.

- [ ] **Step 3: Implement the client and driver**

Use one attached OpenCode server/session. Preserve native IDs in evidence. Never infer completion from
idle alone. Run `bun install` after adding the workspace package.

- [ ] **Step 4: Run deterministic verification**

Run: `bun test packages/driver-opencode && bun run typecheck`

- [ ] **Step 5: Run the gated real candidate-workspace tracer**

Run:

```bash
TERMBRIDGE_LIVE_OPENCODE=1 \
  bun test packages/driver-opencode/src/e2e.live.test.ts
```

Expected: the configured OpenCode binary/server plans and implements an approved fixture task inside a
managed worktree, returns a frozen candidate SHA, and leaves the base checkout and remote unchanged.
The tracer injects no tracker or GitHub credentials and records binary version, server/schema version,
base SHA, candidate SHA, cursor recovery result, and redacted evidence hashes under
`docs/evidence/autonomous-local/phase-2/opencode-candidate-tracer.md`. The Phase 0 protocol spike is not a
substitute for this tracer, and skipping this command does not satisfy the Phase 2 gate.

- [ ] **Step 6: Commit**

```bash
git add packages/driver-opencode bun.lock \
  docs/evidence/autonomous-local/phase-2/opencode-candidate-tracer.md
git commit -m "feat: add native opencode driver"
```

### Task 15B: Implement human attachment, takeover, and return-to-agent

**Depends on:** Tasks 14 and 15 — takeover semantics must hold for both drivers.

Roadmap §9 Phase 2 requires "human attachment, approval ownership, disconnect, and return-to-agent
behavior are tested" and makes human takeover a Phase 2 exit condition; roadmap §10 requires "human
takeover and return" to pass 3 of 3 as a critical benchmark scenario. No task covered it. This is also
the original product promise — a human watching and intervening — so it cannot be implicit.

**Files:**

- Create: `packages/control-plane/src/application/attachment.ts`
- Create: `packages/control-plane/src/application/attachment.test.ts`
- Modify: `packages/driver-claude/src/driver.ts`
- Modify: `packages/driver-opencode/src/driver.ts`

**Interfaces:**

- Produces: `attach`, `takeOver`, `release`, and `observeAttachment` over a durable attachment record.

- [ ] **Step 1: Write takeover semantics tests**

Assert, for each driver: a human attaching does not by itself take control; an explicit takeover
transfers the write lock and records a durable audit event; while a human holds control the agent's
writes are rejected rather than queued; releasing returns control to the agent with the task state
intact; a human disconnect without release leaves the task paused in `AWAITING_HUMAN_INPUT` rather than
silently resuming autonomous work. Assert approval ownership never transfers to the agent — a human
takeover cannot be used to self-approve a plan.

Assert takeover is durable, not process-local: a daemon restart mid-takeover restores the human as the
control holder. The V1 write lock is an advisory TTL lock and is not sufficient on its own.

- [ ] **Step 2: Implement attachment and takeover**

Back the attachment record with the durable store and the lease fence, so a stale worker cannot reclaim
control from a human. Emit `human_took_over` and `human_released` as durable events on the task stream.

- [ ] **Step 3: Verify and commit**

Run: `bun test packages/control-plane/src/application/attachment.test.ts packages/driver-claude packages/driver-opencode && bun run typecheck`

```bash
git add packages/control-plane/src/application/attachment.ts \
  packages/control-plane/src/application/attachment.test.ts \
  packages/driver-claude/src/driver.ts packages/driver-opencode/src/driver.ts
git commit -m "feat: add durable human takeover and return"
```

- [ ] **Step 4: Record the Phase 2 gate evidence**

Create `docs/evidence/autonomous-local/phase-2/gate.md` recording, per gate criterion, the command, exit
code, Git SHA, timestamp, and artifact path.

**Phase 2 gate** — run `bun scripts/gate-check.ts --phase 2`:

1. Both drivers pass their lifecycle and recovery suites — `bun test packages/driver-claude
   packages/core packages/orchestrator` and `bun test packages/driver-opencode`.
2. Both drivers pass their **containment** suites, meaning specifically: denied-path enforcement before
   execution, sandbox policy honored, no network egress beyond the declared policy, and Plan-mode bash
   denial for OpenCode. ("Containment suite" previously appeared nowhere else in this plan; these four
   assertions are what it means.)
3. Each driver completes the real candidate-workspace tracer, with evidence at
   `phase-2/claude-candidate-tracer.md` and `phase-2/opencode-candidate-tracer.md`. Skipping the gated
   live command does not satisfy this, and the Phase 0 protocol spike is not a substitute.
4. Tracker and GitHub credentials remain outside runtimes — **both** Task 14 and Task 15 assert the
   absence of `GH_TOKEN`, `GH_HOST`, and Jira/Linear/GitHub App credentials in the task runtime
   environment. A one-sided assertion does not close a two-driver criterion.
5. Human takeover and return behave correctly — Task 15B's suite passes.
6. `docs/evidence/autonomous-local/phase-2/gate.md` exists and validates.

---

## Phase 3 — Verification, review, evidence, and secrets

### Task 16: Add versioned project policy and verification runner

**Depends on:** Task 12A (consumes the shared redaction canary corpus) and Task 3 (the deterministic
grader shape declared by the benchmark manifest schema).

**Files:**

- Create: `packages/control-plane/src/policy/project-policy.ts`
- Create: `packages/control-plane/src/policy/project-policy.test.ts`
- Create: `packages/control-plane/src/verification/runner.ts`
- Create: `packages/control-plane/src/verification/runner.test.ts`
- Create: `packages/control-plane/src/verification/artifacts.ts`
- Create: `packages/control-plane/src/verification/graders.ts`
- Create: `packages/control-plane/src/verification/graders.test.ts`

**Interfaces:**

- Produces: `parseProjectPolicy(yaml): ProjectPolicy` and `exportProjectPolicy(policy): string`.
- Produces: `VerificationRunner.run(candidate, policy): Promise<VerificationRun>`.
- Produces: deterministic graders for the 10 design §11.4 categories.

- [ ] **Step 1: Write policy, runner, and final-diff scanner tests**

Cover unknown keys, forbidden delivery flags, command timeout, process-tree kill, exit/signal capture,
artifact hashing, required/optional commands, denied paths, candidate SHA binding, and deterministic grader
results.

**Parse and enforce every design §8 field, not a subset.** Assert one test per leaf field:

- `version`.
- `tracker`: `provider`, `project`, `trigger_state_id`, `cancellation_states`,
  `authorized_approver_ids`. A task must move to a paused state when its issue enters a
  `cancellation_states` value, and only an `authorized_approver_ids` member can approve a plan.
- `repository`: `github_installation_id`, `repository`, `base_branch`, `allowed_paths`, `denied_paths`.
  **Both halves of the containment model are enforced** — a change outside `allowed_paths` is rejected
  even when it matches no `denied_paths` glob. Enforce before execution and again against the final
  diff.
- `implementation`: `drivers.allowed`, `drivers.default`, `max_iterations`, `wall_clock_minutes`,
  `budget_units`. Exceeding `max_iterations` or `wall_clock_minutes` pauses the task; it never silently
  passes.
- `verification`: `commands[].id/run/timeout_seconds`, `required`, `github_checks`.
- `review`: `mode`, `required`, `profile`, `blocking_severities`, `max_repair_cycles`, `budget_units`.
- `delivery`: `draft_only`, `allow_mark_ready`, `allow_merge` — snake_case, matching the design YAML.
- `retention`: `successful_worktree_days`, `failed_worktree_days`, `evidence_days`. These drive Task 13's
  worktree cleanup and Task 11's event pruning; an unparsed retention policy means state grows forever.
- `max_changed_files`: a changed-file ceiling required by roadmap §9 Phase 3. Design §8 has no such
  field; add it there too.

**Policy precedence (design §8):** assert repository-owned configuration may *suggest* verification
commands but cannot grant permissions, widen `allowed_paths`, weaken `denied_paths`, or flip any
`delivery` flag. A repository that ships a hostile config file must not be able to escalate.

**Policy export:** assert `exportProjectPolicy` round-trips through `parseProjectPolicy` unchanged. The
design calls the policy "exportable as schema-validated YAML"; a parser alone does not deliver that.

**Grader authoring:** `graders.ts` was previously listed as a file with no step describing it. Implement
deterministic graders for all 10 design §11.4 categories and assert each is reproducible — the same
candidate scores identically across runs.

Final-diff scanner tests (required by design §10.4): assert the scanner checks the frozen candidate diff
for: changed paths against `denied_paths` globs; symlinks that escape the worktree; submodule references;
secret canary matches (consuming the shared canary corpus from Task 12A); binary/oversized artifacts; and
candidate/evidence hash consistency. Assert any redaction hit blocks delivery.

- [ ] **Step 2: Run tests**

Run: `bun test packages/control-plane/src/policy packages/control-plane/src/verification`

Expected: FAIL before implementation.

- [ ] **Step 3: Implement schema validation and command execution**

Execute argument-safe configured commands inside the workspace runtime. Store redacted logs and hashes,
not unbounded raw output in SQLite.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/control-plane/src/policy packages/control-plane/src/verification && bun run typecheck`

```bash
git add packages/control-plane/src/policy packages/control-plane/src/verification
git commit -m "feat: verify candidates against project policy"
```

### Task 17: Add independent reviewer profiles and repair orchestration

**Depends on:** Tasks 12B and 16 — modifies `task-service.ts` and `synthetic-tracer.test.ts`, both
created by Task 12B, and consumes Task 16's verification verdicts.

**Files:**

- Create: `packages/control-plane/src/review/reviewer.ts`
- Create: `packages/control-plane/src/review/reviewer.test.ts`
- Create: `packages/control-plane/src/review/findings.ts`
- Create: `packages/control-plane/src/review/repair-loop.ts`
- Create: `packages/control-plane/src/review/repair-loop.test.ts`
- Modify: `packages/control-plane/src/application/task-service.ts`
- Modify: `packages/control-plane/src/e2e/synthetic-tracer.test.ts`

**Interfaces:**

- Produces: `ReviewCoordinator.review(candidate, profile): Promise<ReviewRun>`.
- Produces: `RepairCoordinator.nextAction(result): RepairAction`.

- [ ] **Step 1: Write review-mode and invalidation tests**

Cover off, same-model-fresh-session, different-model, named profile, blocking severity, advisory finding,
budget pause, repeated finding, maximum repair cycles, and candidate-change invalidation.

- [ ] **Step 2: Implement structured review**

Validate reviewer output against the finding schema. Never give the reviewer implementer private
reasoning. Bind prompt/model/profile/version/verdict to candidate SHA.

- [ ] **Step 3: Implement repair routing**

Every repair returns through full verification and required review. Identical blocking findings count
toward repeated-failure limits.

**Enforce every limit roadmap §9 Phase 3 names**, not only repair cycles and budget: cost
(`review.budget_units`), attempts (`implementation.max_iterations`), repeated failure, **changed files**
(`implementation.max_changed_files`), and **wall clock** (`implementation.wall_clock_minutes`). Each
limit pauses the task with a distinct stable error code from the Task 8 catalog. A required review that
runs out of budget pauses; it is never silently skipped.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/control-plane/src/review packages/control-plane/src/e2e && bun run typecheck`

```bash
git add packages/control-plane/src/review packages/control-plane/src/application/task-service.ts \
  packages/control-plane/src/e2e/synthetic-tracer.test.ts
git commit -m "feat: add independent review and repair loops"
```

### Task 18: Implement secret providers, streaming redaction, and evidence bundles

**Depends on:** Task 12A — the redactor tests enumerate exactly the canary-corpus surfaces defined
there.

**Files:**

- Create: `packages/control-plane/src/secrets/provider.ts`
- Create: `packages/control-plane/src/secrets/os-provider.ts`
- Create: `packages/control-plane/src/secrets/encrypted-file-provider.ts`
- Create: `packages/control-plane/src/secrets/provider.test.ts`
- Create: `packages/control-plane/src/redaction/redactor.ts`
- Create: `packages/control-plane/src/redaction/redactor.test.ts`
- Create: `packages/control-plane/src/evidence/bundle.ts`
- Create: `packages/control-plane/src/evidence/bundle.test.ts`
- Create: `packages/control-plane/src/evidence/diagnostics-export.ts`
- Create: `packages/control-plane/src/evidence/diagnostics-export.test.ts`

**Interfaces:**

- Produces: `SecretProvider.resolve(ref): Promise<SecretLease>`.
- Produces: `StreamingRedactor.push(chunk): RedactedChunk`.
- Produces: `buildEvidenceBundle(taskId): Promise<EvidenceBundle>`.
- Produces: `exportDiagnostics(input): Promise<DiagnosticArchive>` with allowlist, operator preview,
  redaction manifest, and explicit consent (roadmap §11 and Phase 5 deliverable).

- [ ] **Step 1: Write canary and chunk-boundary tests**

Cover exact, base64, URL-encoded, split-across-chunks, structured object, URL, environment, transcript,
SQLite, tracker comment, PR body, UI event, and diagnostic export surfaces.

- [ ] **Step 2: Implement provider interfaces and redaction**

Use OS credential stores where available. The encrypted fallback requires interactive unlock and stores
salt/nonce/ciphertext only. Zero secret buffers after use where runtime APIs permit.

- [ ] **Step 3: Build allowlisted evidence bundles**

Include hashes, versions, commands, results, findings, audit references, and artifact pointers. Block
bundle publication on any redaction hit requiring inspection.

- [ ] **Step 4: Implement diagnostic export**

Roadmap §11 and the Phase 5 deliverables require an operator-facing diagnostic export that is safe to
send to a third party. Implement `exportDiagnostics` with: an explicit allowlist of included artifacts
(never an exclude-list), a preview the operator sees before anything is written, a redaction manifest
recording every rule applied and every hit count, and an explicit consent step before the archive is
produced. Assert the canary corpus is absent from a generated archive.

- [ ] **Step 5: Record the Phase 3 gate evidence**

Create `docs/evidence/autonomous-local/phase-3/gate.md` recording, per gate criterion, the command, exit
code, Git SHA, timestamp, and artifact path. Step 6's `git add` targets this directory.

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/control-plane/src/secrets packages/control-plane/src/redaction packages/control-plane/src/evidence && bun run typecheck`

```bash
git add packages/control-plane/src/secrets packages/control-plane/src/redaction \
  packages/control-plane/src/evidence docs/evidence/autonomous-local/phase-3
git commit -m "feat: secure autonomous evidence"
```

**Phase 3 gate** — run `bun scripts/gate-check.ts --phase 3`:

1. The failure→repair→review→repair tracer passes — `bun test packages/control-plane/src/e2e`.
2. Evidence cannot be reused across SHAs — the candidate-SHA binding and candidate-change invalidation
   assertions in Tasks 16 and 17 both fail closed when the candidate SHA changes.
3. Required review pauses on budget exhaustion — Task 17's budget-pause assertion.
4. The final-diff scanner rejects symlinks, submodules, binaries, oversized artifacts, denied paths, and
   `allowed_paths` violations — Task 16 Step 1.
5. Evidence-bundle publication blocks on any redaction hit — Task 18 Step 3.
6. The canary corpus is absent from each of the 13 surfaces enumerated in Task 18 Step 1, and from a
   generated diagnostic export — Task 18 Steps 1 and 4.

---

## Phase 4A — GitHub draft delivery

Phase 4 is split into three separately gated sub-phases, matching roadmap §9 and design §12. GitHub
draft-delivery correctness is gated before any tracker integration begins, so a delivery defect cannot
be discovered only after two tracker adapters are built on top of it.

### Task 19: Implement GitHub App authentication and webhook inbox

**Depends on:** Task 8 — `WebhookInbox` lives in the control plane and stores `SecretRef`.

**Files:**

- Create: `packages/forge-github/package.json`
- Create: `packages/forge-github/tsconfig.json`
- Create: `packages/forge-github/src/index.ts`
- Create: `packages/forge-github/src/auth.ts`
- Create: `packages/forge-github/src/client.ts`
- Create: `packages/forge-github/src/webhook.ts`
- Create: `packages/forge-github/src/webhook.test.ts`
- Create: `packages/control-plane/src/ingress/webhook-inbox.ts`
- Create: `packages/control-plane/src/ingress/webhook-inbox.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Produces: `GitHubInstallationTokenProvider`.
- Produces: `verifyGitHubWebhook(raw, headers): VerifiedDelivery`.
- Produces: `WebhookInbox.receive(provider, delivery): ReceiveResult`.

- [ ] **Step 1: Write signature, dedupe, and permission tests**

Cover valid/invalid signatures, raw-body preservation, duplicate delivery ID, out-of-order events,
installation suspension/removal, selected repository change, token expiration, and required permission
validation.

- [ ] **Step 2: Implement short-lived installation token minting**

Store only private-key `SecretRef`; mint repository-narrowed installation tokens when executing a forge
operation. Never expose token values to task events or drivers.

- [ ] **Step 3: Implement durable inbox**

Persist verified receipt before acknowledgement. Queue normalized changes. Reject signature failure
before task creation. Run `bun install` after adding the workspace package.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/forge-github packages/control-plane/src/ingress && bun run typecheck`

```bash
git add packages/forge-github packages/control-plane/src/ingress bun.lock
git commit -m "feat: authenticate github app deliveries"
```

### Task 20: Implement deterministic GitHub draft delivery and checks

**Depends on:** Tasks 19, 12A, 12B, 16, 17, and 18. It builds inside Task 19's package and its verify
command runs Task 19's tests; `pr-body.ts` consumes Task 16's verification results, Task 17's review
findings, and Task 18's evidence bundle; canary blocking uses Task 12A's corpus; it modifies Task 12B's
`task-service.ts`.

**Files:**

- Create: `packages/forge-github/src/forge.ts`
- Create: `packages/forge-github/src/forge.test.ts`
- Create: `packages/forge-github/src/checks.ts`
- Create: `packages/forge-github/src/pr-body.ts`
- Create: `packages/forge-github/src/pr-body.test.ts`
- Create: `packages/forge-github/src/reconcile.ts`
- Create: `packages/forge-github/src/e2e.test.ts`
- Modify: `packages/control-plane/src/application/task-service.ts`

**Interfaces:**

- Implements: `DraftPullRequestForge`.
- Produces deterministic operation keys for push, draft create/update, and check observation.

- [ ] **Step 1: Write fake-GitHub delivery tests**

Cover base SHA, branch collision, expected remote OID, already-created PR, `422` reconciliation, uncertain
push, uncertain PR create, branch tampering, failed/canceled/timed-out checks, and exact SHA success.

- [ ] **Step 2: Implement host commit/push, draft PR, and evidence-rich PR body**

Use the frozen candidate tree. Search by deterministic head branch and persisted PR identity before
retry. Never force push over an unrecognized remote head.

`pr-body.ts` constructs the draft PR body from the durable evidence bundle. The body MUST contain: source
issue link, approved-plan hash, policy version, verification results, review findings and verdict, base
SHA, candidate SHA, evidence bundle reference, and redaction confirmation. The body must NOT contain
terminal transcripts, raw credentials, or implementer private reasoning. Test that a redacted body is
produced and that any canary-secret hit in the body blocks PR creation.

- [ ] **Step 3: Add contract-absence test**

Use a compile/runtime surface assertion that the forge and Local route registries contain no ready,
approve, merge, bypass, or deployment operation.

- [ ] **Step 4: Record the Phase 4A gate evidence**

Create `docs/evidence/autonomous-local/phase-4a/gate.md` recording, per gate criterion, the command,
exit code, Git SHA, timestamp, and artifact path. Step 5's `git add` targets this directory.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/forge-github packages/control-plane/src/e2e && bun run typecheck`

```bash
git add packages/forge-github packages/control-plane/src/application/task-service.ts \
  docs/evidence/autonomous-local/phase-4a
git commit -m "feat: deliver verified github draft pull requests"
```

**Phase 4A gate** — run `bun scripts/gate-check.ts --phase 4a`:

1. Exactly-one draft delivery survives the crash and reconciliation matrix — `bun test
   packages/forge-github/src/e2e.test.ts`, covering the enumerated crash points in Task 20 Step 1.
2. No merge-equivalent application operation exists — Task 20 Step 3's compile/runtime surface
   assertion over the forge and Local route registries, plus Task 8's compile-time absence assertion on
   `DraftPullRequestForge`.
3. Branch tampering pauses the task rather than overwriting human work — Task 20 Step 1.
4. No control-plane credential reaches a coding runtime — the negative-environment assertions in
   Tasks 14 and 15 both pass, and `forge-github` never appears in a driver's injected environment.
5. `docs/evidence/autonomous-local/phase-4a/gate.md` exists and validates.

---

## Phase 4B — Linear status-to-draft-PR

### Task 21: Implement shared tracker reconciliation and Local approval commands

**Depends on:** Tasks 9, 12A, and 19 — needs `validateApproval` from Task 9, modifies Task 12A's
`v2-tasks.ts` and `server.ts`, and consumes `WebhookInbox.receive` from Task 19.

**Files:**

- Create: `packages/control-plane/src/application/tracker-sync.ts`
- Create: `packages/control-plane/src/application/tracker-sync.test.ts`
- Create: `packages/control-plane/src/application/approval-service.ts`
- Create: `packages/control-plane/src/application/approval-service.test.ts`
- Modify: `packages/server/src/routes/v2-tasks.ts`
- Create: `packages/server/src/routes/approvals.ts`
- Create: `packages/server/src/routes/webhooks.ts`
- Modify: `packages/server/src/server.ts`

**Interfaces:**

- Produces: `TrackerSync.pollProject`, `processChange`, and `publishState`.
- Produces: `ApprovalService.approve/reject` with local reauthentication.
- Produces: `POST /api/v2/tasks/:id/approve`, `.../reject`, `.../cancel`.

- [ ] **Step 1: Write reconciliation and stale-approval tests**

Cover status entry, status exit, issue edit, duplicate change, stale cursor, active-run uniqueness,
approval actor, cancellation, and correctness with webhooks disabled — polling and reconciliation are
the baseline, so the suite must pass with no webhook delivery at all.

Approval validity binds the exact plan hash, issue snapshot hash, base SHA, and policy version. Assert
**all nine** design §5.4 invalidation causes, one test each — the previous list covered four:

1. material issue changes;
2. repository or base changes;
3. stale base beyond policy;
4. plan changes;
5. policy changes;
6. selected driver changes;
7. required reviewer changes;
8. security classification changes;
9. expiration.

Causes 3, 4, 6, 7, and 8 were previously untested. A driver or reviewer swapped after approval means the
human approved work that a different system will now perform.

- [ ] **Step 2: Implement typed application commands**

HTTP routes validate Zod schemas and call application services only. They do not mutate repositories
directly.

- [ ] **Step 3: Add loopback security tests**

Cover bearer/session auth, Host/Origin, CSRF, reauthentication, body limits, and separation of public
webhook routes from management routes.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/control-plane/src/application packages/server/src && bun run typecheck`

```bash
git add packages/control-plane/src/application packages/server/src/routes packages/server/src/server.ts
git commit -m "feat: expose approved tracker task commands"
```

### Task 22: Implement the Linear adapter and live tracer

**Depends on:** Tasks 8, 13, 14, 15, 16, 19, 20, and 21. The live matrix drives issue-state → approved
plan → checked draft PR through both CLIs, so it needs both drivers, managed worktrees, verification,
GitHub App auth, draft delivery, and the approval command path. It must pass
`ports/tracker.contract.test.ts` from Task 8 before its own adapter tests.

**Files:**

- Create: `packages/tracker-linear/package.json`
- Create: `packages/tracker-linear/tsconfig.json`
- Create: `packages/tracker-linear/src/index.ts`
- Create: `packages/tracker-linear/src/auth.ts`
- Create: `packages/tracker-linear/src/client.ts`
- Create: `packages/tracker-linear/src/normalize.ts`
- Create: `packages/tracker-linear/src/webhook.ts`
- Create: `packages/tracker-linear/src/adapter.ts`
- Create: `packages/tracker-linear/src/adapter.test.ts`
- Create: `packages/tracker-linear/src/e2e.live.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Implements: `WorkTrackerAdapter`.
- Persists app actor/workspace ID, granted teams/scopes, token version, cursor, and webhook identity.

- [ ] **Step 1: Write recorded-fixture adapter tests**

Cover OAuth rotation/revocation, HMAC/timestamp/delivery verification, Relay cursor pagination,
configured workflow-state IDs, issue/comment/label/file normalization, rate/complexity limits,
permission change, publication reconciliation, and Agent Session capability fallback.

- [ ] **Step 2: Implement OAuth, GraphQL, normalization, and publication**

Use provider IDs, not display names. Update one durable bot-authored compatibility comment or native
Agent Activities when the discovered preview capability is enabled. Run `bun install` after adding the
workspace package.

- [ ] **Step 3: Run deterministic tests**

Run: `bun test packages/tracker-linear && bun run typecheck`

Expected: PASS without network access.

- [ ] **Step 4: Run the gated live matrix**

Run the matrix once per driver so each has its own recorded result:

```bash
TERMBRIDGE_LIVE_LINEAR=1 TERMBRIDGE_DRIVER=claude-code bun test packages/tracker-linear/src/e2e.live.test.ts
TERMBRIDGE_LIVE_LINEAR=1 TERMBRIDGE_DRIVER=opencode    bun test packages/tracker-linear/src/e2e.live.test.ts
```

Expected: Claude Code and OpenCode each complete issue-state → approved plan → checked draft PR.

- [ ] **Step 5: Record the Phase 4B gate evidence**

Create `docs/evidence/autonomous-local/phase-4b/gate.md` with one record per driver: the command, exit
code, Git SHA, timestamp, issue reference, resulting PR URL, and artifact path. A single combined record
does not satisfy "both drivers" — the gate needs a per-driver result.

- [ ] **Step 6: Commit**

```bash
git add packages/tracker-linear bun.lock docs/evidence/autonomous-local/phase-4b
git commit -m "feat: connect linear workflow intake"
```

**Phase 4B gate** — run `bun scripts/gate-check.ts --phase 4b`:

1. Linear intake is correct without webhooks — the polling/reconciliation tests in Task 21 pass with
   webhook delivery disabled.
2. Duplicate and out-of-order deliveries produce exactly one task — Task 21's idempotency assertions.
3. Both drivers complete the live Linear matrix — two per-driver records in
   `docs/evidence/autonomous-local/phase-4b/gate.md`.
4. Approval binds the exact plan hash, issue snapshot hash, base SHA, and policy version, and all 9
   invalidation causes are asserted — Task 21 Step 1.

---

## Phase 4C — Jira status-to-draft-PR

### Task 23: Implement the Jira adapter and live tracer

**Depends on:** Tasks 8, 13, 14, 15, 16, 19, 20, and 21 — the same set as Task 22, for the same reason.
Tasks 22 and 23 may run in parallel with each other once those dependencies are met.

**Files:**

- Create: `packages/tracker-jira/package.json`
- Create: `packages/tracker-jira/tsconfig.json`
- Create: `packages/tracker-jira/src/index.ts`
- Create: `packages/tracker-jira/src/auth.ts`
- Create: `packages/tracker-jira/src/client.ts`
- Create: `packages/tracker-jira/src/adf.ts`
- Create: `packages/tracker-jira/src/normalize.ts`
- Create: `packages/tracker-jira/src/webhook.ts`
- Create: `packages/tracker-jira/src/adapter.ts`
- Create: `packages/tracker-jira/src/adapter.test.ts`
- Create: `packages/tracker-jira/src/e2e.live.test.ts`
- Modify: `bun.lock`

**Interfaces:**

- Implements: `WorkTrackerAdapter`.
- Persists cloud ID, account identity, scopes, token version, polling cursor, dynamic webhook ID/expiry,
  and configured workflow transition/state IDs.

- [ ] **Step 1: Write recorded-fixture adapter tests**

Cover 3LO refresh/revocation, signed/retried webhook dedupe, expiration renewal, endpoint-specific
pagination, ADF round-trip, comments, attachments, changelog, transition discovery, rate-limit headers,
permission reduction, and uncertain publication reconciliation.

- [ ] **Step 2: Implement OAuth, REST v3, ADF, normalization, and publication**

Discover allowed transitions before changing provider status. Never hard-code workflow names or
transition IDs. Gate Remote Agents behind an experimental capability. Run `bun install` after adding the
workspace package.

- [ ] **Step 3: Run deterministic tests**

Run: `bun test packages/tracker-jira && bun run typecheck`

Expected: PASS without network access.

- [ ] **Step 4: Run the gated live matrix**

Run the matrix once per driver so each has its own recorded result:

```bash
TERMBRIDGE_LIVE_JIRA=1 TERMBRIDGE_DRIVER=claude-code bun test packages/tracker-jira/src/e2e.live.test.ts
TERMBRIDGE_LIVE_JIRA=1 TERMBRIDGE_DRIVER=opencode    bun test packages/tracker-jira/src/e2e.live.test.ts
```

Expected: Claude Code and OpenCode each complete issue-state → approved plan → checked draft PR.

- [ ] **Step 5: Record the Phase 4C gate evidence**

Create `docs/evidence/autonomous-local/phase-4c/gate.md` with one record per driver: the command, exit
code, Git SHA, timestamp, issue reference, resulting PR URL, and artifact path.

- [ ] **Step 6: Commit**

```bash
git add packages/tracker-jira bun.lock docs/evidence/autonomous-local/phase-4c
git commit -m "feat: connect jira workflow intake"
```

**Phase 4C gate** — run `bun scripts/gate-check.ts --phase 4c`:

1. Jira intake is correct without webhooks — polling/reconciliation tests pass with webhook delivery
   disabled; expiring webhook renewal is asserted separately.
2. Transitions are discovered, never hard-coded — Task 23 Step 1's transition-discovery assertion.
3. Both drivers complete the live Jira matrix — two per-driver records in
   `docs/evidence/autonomous-local/phase-4c/gate.md`.
4. Jira Remote Agents remain behind an experimental capability flag — Task 23 Step 2.

---

## Phase 5 — Local product, benchmark, and stable pilot

### Task 24: Build Local setup, dashboard, health, and recovery UX

**Depends on:** Tasks 8, 10, 11, 12A, 12B, 14, 15, 18, 19, 20, 21, 22, and 23. This is the composition
root — it injects SQLite, the secret provider, both drivers, both trackers, the forge, the scheduler,
and the application services, so every one of them must exist first.

**Files:**

- Create: `packages/server/src/composition.ts`
- Create: `packages/server/src/routes/installations.ts`
- Create: `packages/server/src/routes/projects.ts`
- Create: `packages/server/src/routes/evidence.ts`
- Create: `packages/server/src/routes/health.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/client/main.ts`
- Create: `packages/server/client/api.ts`
- Create: `packages/server/client/views/setup.ts`
- Create: `packages/server/client/views/tasks.ts`
- Create: `packages/server/client/views/task-detail.ts`
- Create: `packages/server/client/views/evidence.ts`
- Create: `packages/server/src/local.e2e.test.ts`

**Interfaces:**

- Produces one composition root that injects SQLite, secret provider, drivers, trackers, forge, scheduler,
  and application services.
- Produces setup, task list/detail, approval, question, cancellation, recovery, cost, and evidence flows.

- [ ] **Step 1: Write browser/API E2E for first-run through handoff**

Use fake providers and drivers. Assert loopback bootstrap, installation diagnostics, mapping, plan
approval, live timeline, question, cancellation, recovery, evidence, and final draft link.

**Non-loopback bind fails startup (V2-D11).** Assert the daemon refuses to start when configured to
bind a non-loopback address, with an error naming Local's single-user security model. A configuration
flag must not be able to turn Local into an unauthenticated team server; that is the whole content of
the Local-versus-Platform boundary.

**Guided setup covers every configurable surface** roadmap §9 Phase 5 lists: trackers, status mappings,
trigger states, drivers, verification commands, review policy, budgets, **retention**, and **webhook
ingress**. Retention and webhook ingress were previously unasserted — an operator who cannot configure
retention has no way to bound disk growth.

**Human takeover in the dashboard.** Assert the task detail view can attach to a live session, take
over, and return control, driving Task 15B's application service. Watching without being able to
intervene is not the product.

- [ ] **Step 2: Implement composition and route modules**

Keep `createTermbridgeServer` compatibility while adding an injected `LocalApplication` option. Remove
long-lived tokens from URLs through one-time bootstrap exchange and secure cookie.

- [ ] **Step 3: Implement focused UI views**

Render typed server events. Display fallback driver mode, approval hashes, candidate/test/review/PR SHAs,
budgets, pause reason, and concrete recovery actions.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/server && bun run build && bun run typecheck`

```bash
git add packages/server
git commit -m "feat: add autonomous local dashboard"
```

### Task 25: Add benchmark runner, security/fault release suite, packaging, and four-week pilot evidence

**Depends on:** Tasks 3, 14, 15, and 24 — the benchmark manifest and fixtures come from Task 3, the
20 × 3 matrix runs against both required CLIs from Tasks 14 and 15, and the install/backup/restore
lifecycle scripts drive Task 24's composition root.

**Files:**

- Create: `benchmarks/autonomous-local/runner.ts`
- Create: `benchmarks/autonomous-local/runner.test.ts`
- Create: `scripts/test-autonomous-fault-matrix.ts`
- Create: `scripts/test-autonomous-security.ts`
- Create: `scripts/backup-local.ts`
- Create: `scripts/restore-local.ts`
- Create: `scripts/doctor-local.ts`
- Create: `scripts/install-local.ts`
- Create: `scripts/upgrade-local.ts`
- Create: `scripts/rollback-local.ts`
- Create: `scripts/uninstall-local.ts`
- Create: `scripts/rotate-credentials.ts`
- Create: `scripts/generate-sbom.ts`
- Create: `benchmarks/autonomous-local/pilot-ledger.schema.json`
- Create: `benchmarks/autonomous-local/pilot-ledger.test.ts`
- Create: `docs/integration/autonomous-local.md`
- Create: `docs/evidence/autonomous-local/release/README.md`
- Create: `docs/evidence/autonomous-local/release/compatibility-matrix.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: benchmark runner consuming the Task 3 manifest schema.
- Produces: backup, restore, doctor, install, upgrade, rollback, uninstall, and credential-rotation
  commands.
- Produces: release evidence bundle and pilot ledger.

- [ ] **Step 1: Implement benchmark execution and reporting**

Consume the manifest and the 20 authored cases from Task 3. Run each case three clean times per required
CLI. Publish raw outcomes, category totals, 95% Wilson intervals, elapsed time, usage, fallback
activation, and policy violations. Infrastructure-invalid runs remain visible and follow the manifest's
predeclared rerun rate cap.

Also publish **regressions versus the previous stable version** (roadmap §10): per case and per
category, the delta against the last published stable result, flagging any case that regressed from pass
to fail. A benchmark that cannot show movement between releases cannot detect decay.

Implement the two secondary run modes declared in the Task 3 budget policy: **latest-upstream canaries**,
reported separately and never auto-expanding the supported version range, and **nightly smoke**, one
attempt per case, explicitly labelled as not a stable-matrix substitute.

Report `critical_scenario` results separately: every one of the 18 must show 3 of 3. Aggregate
completion never masks a critical failure.

- [ ] **Step 2: Implement release fault/security commands**

Cover every journal boundary, duplicate/out-of-order webhook, OAuth revocation, malicious repo hooks,
symlink/path escape, cross-workspace access, prompt injection, encoded secret exfiltration, branch
tampering, and attempts to ready/merge/deploy.

Emit findings against a declared finding schema — id, severity, surface, reproduction — so "zero secret
or prohibited-operation finding" is a count over structured records rather than a reviewer's impression.

**Supply-chain evidence (roadmap §11):** `generate-sbom.ts` produces an SBOM plus provenance attestation
for every stable candidate, and CI runs dependency review and static checks on each candidate. Wire all
three into `.github/workflows/ci.yml` so they gate rather than merely report.

**Compatibility matrix (roadmap §12):** generate `compatibility-matrix.md` recording, per release, the
supported CLI versions and schema hashes, the MCP tool contract version, and the supported MCP
transports — both stdio and Streamable HTTP remain in the support window.

- [ ] **Step 3: Verify clean-machine lifecycle with executable commands**

Run each of these against a clean supported-host CI image and record the command, exit code, and artifact
path:

```bash
bun scripts/install-local.ts --target /tmp/termbridge-clean
bun scripts/doctor-local.ts --home /tmp/termbridge-clean
bun scripts/backup-local.ts --home /tmp/termbridge-clean --out /tmp/tb-backup
bun scripts/restore-local.ts --home /tmp/termbridge-clean --from /tmp/tb-backup
bun scripts/upgrade-local.ts --home /tmp/termbridge-clean --to <new-version>
bun scripts/rollback-local.ts --home /tmp/termbridge-clean --to <old-version>
bun scripts/rotate-credentials.ts --home /tmp/termbridge-clean
bun scripts/uninstall-local.ts --home /tmp/termbridge-clean
```

Expected: each script exits zero, produces a dated evidence record under
`docs/evidence/autonomous-local/release/`, and leaves the installation in a valid state. Install then
restore must reproduce active tasks. Upgrade then rollback must return to the prior version with no schema
drift. Uninstall must remove all state and credentials with a confirmed evidence record.

- [ ] **Step 4: Run stable candidate gates**

Run:

```bash
bun run lint
bun run typecheck
bun test
bun run build
bun run benchmark:autonomous-local
bun run test:faults
bun run test:security
bun scripts/generate-sbom.ts
bun scripts/gate-check.ts --phase release
```

Expected: each CLI scores at least 54/60; each of the 18 `critical_scenario` values records 3/3; zero
secret and zero prohibited-operation findings against the declared finding schema; SBOM and provenance
attestation produced; every prior phase gate has a validating evidence file.

- [ ] **Step 5: Conduct and record the controlled pilot**

Run four continuous weeks, at least 30 real tasks, three repositories, both trackers, both drivers,
required and disabled review policies, daemon restart, and provider outage. Record every task's human
intervention, cost, outcome, and evidence links.

Record it as **structured data, not prose.** `pilot-ledger.schema.json` defines one record per task —
task id, tracker, driver, repository, review policy, human interventions, cost, outcome, evidence links,
and any incident class — and `pilot-ledger.test.ts` validates the ledger and computes the stable-gate
counts: lost tasks, duplicate runs or PRs, unauthorized pushes, false successes, secret leaks, and
ready/merge/deploy operations. Mirror the `ProjectStatus`/`status:check` pattern from Task 1. A prose
ledger cannot be checked, and "zero lost tasks" over 30 tasks and four weeks is not a claim anyone
should be asked to take on trust.

- [ ] **Step 6: Publish release evidence and commit**

```bash
git add benchmarks scripts package.json .github/workflows/ci.yml README.md CHANGELOG.md \
  docs/integration/autonomous-local.md docs/evidence/autonomous-local/release
git commit -m "release: qualify autonomous local 1.0"
```

**Stable gate** — run `bun scripts/gate-check.ts --phase release`:

1. Every prior phase gate has a recorded, validating evidence file: `phase-0`, `phase-1`, `phase-2`,
   `phase-3`, `phase-4a`, `phase-4b`, `phase-4c`.
2. All deterministic, live, fault, security, benchmark, and clean-machine install commands exit zero —
   the seven-command block and the eight-command lifecycle block in Task 25 Steps 3 and 4.
3. Each CLI scores at least 54 of 60.
4. Every one of the 18 `critical_scenario` values from roadmap §10 records 3 of 3. This is computable
   because Task 3's manifest schema makes `critical_scenario` a required enum; aggregate completion
   cannot mask a critical failure.
5. Zero secret findings and zero prohibited-operation findings, where "finding" means a record matching
   the finding schema emitted by `test:security` — not a reviewer impression.
6. The pilot ledger validates against `pilot-ledger.schema.json` and reports zero lost tasks, zero
   duplicate runs or PRs, zero unauthorized pushes, zero false successes, zero secret leaks, and zero
   ready, merge, or deploy operations across at least 30 real tasks, three repositories, both trackers,
   both drivers, and four continuous weeks.
7. SBOM, provenance attestation, and dependency-review results are attached to the release bundle.

---

## Program execution and review policy

1. Execute tasks in order within a phase. A phase gate requires maintainer review before the next phase.
2. In Phase 0, complete Task 0 first. Tasks 1, 2A, 2C, 3, 4, 5, 6, and 7 may then run in parallel;
   Task 2B waits for Tasks 1, 4, and 5, while Tasks 6 and 7 block Task 8.
2b. **Every task from Task 9 onward carries an explicit `Depends on:` line. Those lines are the
   authoritative DAG — a parallelizing executor must read them, not the prose ordering in rule 1.**
   The narrative "execute tasks in order within a phase" is a fallback for humans, not a substitute
   for the declared edges.
3. Keep at most one state/schema/migration task active.
4. Provider adapters may run in parallel only after their shared port and fixture contracts pass.
5. Every task receives:
   - implementation review against its interfaces;
   - test review against failure behavior;
   - secret/capability review when it touches credentials, runtimes, Git, or network ingress.
6. Record phase evidence before widening scope.
7. If an upstream CLI or provider contract contradicts the design, stop and amend the ADR/spec/plan
   before adding a workaround.
8. Never reduce a stable gate merely to preserve a date. Change scope only through an explicit roadmap
   and ADR revision.

## Final acceptance

The program is complete when a configured Jira or Linear workflow transition produces one task, waits
for approval of the exact plan, runs through Claude Code or OpenCode in an isolated managed worktree,
independently verifies and optionally independently reviews every candidate, repairs failures, creates
exactly one GitHub draft PR, waits for required checks on the exact tested/reviewed SHA, synchronizes
evidence back to the tracker, and reaches `DRAFT_PR_READY_FOR_HUMAN` without any path to ready, merge,
bypass, or deployment.

---

## Revision history

- **2026-07-25 (revised after audit of the accepted baseline):** 30 task blocks across Phase 0–5, up
  from 28. Fixed 12 execution blockers: added the missing `task_events` table and put event append in
  the same transaction as the transition and audit record; replaced the nonexistent `runtime_bindings`
  with `runtime_sessions`; declared the `lease_id`/`fencing_token` columns the fence clauses reference;
  gave every task whose commit targets a phase evidence directory a step that authors it, so five
  commits that would have exited nonzero now work; froze all ~36 design §7 payload types and the ten
  `DriverEvent` kinds rather than only method names; added the three port contract-test files to Task
  8's own file list; enumerated all 17 state transitions, 4 guards, 9 success invariants, and 9
  approval-invalidation causes; corrected `delivery.allowMerge` to the design's `allow_merge`; expanded
  policy coverage from ~11 to all ~32 §8 leaf fields including `allowed_paths` and `retention`; and
  renumbered Task 12A's duplicate steps and completed its `git add`.
  Completed the dependency DAG — 20 explicit `Depends on:` lines, every task from 9 onward, since a
  parallelizing executor reads declared edges and not prose ordering.
  Made every phase gate observable: added `scripts/gate-check.ts` and a gate evidence schema, bound the
  five unbounded universal negatives to their enumerations, defined "containment suite" and
  `critical_scenario` (previously named in gates but nowhere else), and rescoped the Phase 1
  backup/restore criterion off tooling that ships in Phase 5.
  Split Phase 4 into separately gated 4A/4B/4C, matching roadmap §9 and design §12.
  Closed 20 roadmap coverage gaps, adding Task 2C (threat model) and Task 15B (human takeover and
  return), and homing retention, diagnostic export, the 20 benchmark cases, grader categories, upstream
  canaries, regression reporting, SBOM, dependency review, the compatibility matrix, migration dry-run,
  non-loopback startup failure, the WebSocket boundary, changed-file and wall-clock limits, the error
  catalog, install reproducibility, and the pilot ledger schema.
  Corrected the baseline from 762/50/1,831 to the measured 754/49/1,811, reconciled the control-plane
  package boundary into the roadmap and design, fixed the D1–D8/V2-D1–D12 ADR range against a
  `DECISIONS.md` that stops at D4, aligned the schedule estimate, and moved the Phase 1 canary claim off
  a redactor that does not exist until Phase 3.

- **2026-07-25 (revised after independent review):** Expanded Phase 0 from three tasks to nine numbered
  tasks, with Task 2 split into disjoint lint (2A) and authority-document (2B) work. Added executable
  benchmark validation with four pinned licensed fixtures, exact sandbox/Hermes evidence-or-defer
  rules, an OpenCode protocol spike, and a Claude structured-surface brief before the Task 8 schema
  freeze. Added durable event/evidence/audit schemas, a restart-safe event store, cursor-based SSE, and
  golden MCP/HTTP parity in Task 12A. Added real managed-worktree candidate tracers for both Claude Code
  and OpenCode; the protocol spike is not release evidence. Corrected UI paths to the existing
  `packages/server/client` layout and made Phase 0 roadmap ownership sequential. Rationale: the earlier
  plan left several gates descriptive rather than executable and claimed transport/driver outcomes
  without implementation tasks that could produce their required evidence.
- **2026-07-25 (revised after Codex independent review):** Fixed 9 blockers and 7 risks identified by
  an independent Codex review against the actual codebase and design spec:
  1. **Task 2A** — corrected target files to the actual lint locations (`auth/provisioner.ts`,
     `env/docker.ts`, `mcp-server/tools.ts`, `engineer-loop.test.ts`) and the actual count (3 warnings
     + 2 infos, not 1 + 2).
  2. **Task 8** — added explicit port contract-conformance suites for all design §7 methods
     (TrackerAdapter's 12 methods, CodingCliDriver's 8 methods, DraftPullRequestForge's 8 methods plus
     compile-time absence of merge/ready/approve/bypass/deploy).
  3. **Task 10** — added the full 18-table schema checklist from design §6, a migration ledger with
     version/checksum/atomic-failure behavior, and a monotonically increasing `fencing_token` column
     with stale-worker fencing tests.
  4. **Task 11** — added tmux metadata tag writing (`@termbridge.*` options) and the full reconciliation
     matrix from research §2; added stale-worker-after-expiry fencing tests on every durable mutation.
  5. **Task 12A** — added `@termbridge/sdk` generated from shared schemas with HTTP parity, 13 golden
     MCP fixture files (one per legacy tool), the shared redaction canary corpus (moved from Phase 3 to
     Phase 1), and backend-neutral environment conformance for Local/Docker/E2B. Strengthened the
     Phase 1 gate to require SDK, tmux, environment, fencing, and canary evidence.
  6. **Task 14** — explicitly moved `packages/core/src/auth/provisioner.ts` into `driver-claude`; added
     task-specific runtime home, first-run Local-versus-Docker trust choice, and post-plan
     sensitive-effect gate (roadmap Phase 2 deliverables that were missing).
  7. **Task 15** — added explicit OpenCode Plan-mode bash denial configuration and test (research
     requires native denial + outer read-only boundary, not just outer read-only).
  8. **Task 16** — added final-diff secret/path scanner over symlinks, submodules, binaries, oversized
     artifacts, and denied-path globs, consuming the shared canary corpus.
  9. **Task 20** — added `pr-body.ts` constructing the evidence-rich draft PR body from the durable
     evidence bundle, with canary-secret blocking.
  10. **Task 25** — added `install-local.ts`, `upgrade-local.ts`, `rollback-local.ts`,
      `uninstall-local.ts`, and `rotate-credentials.ts` scripts with executable clean-machine lifecycle
      verification commands and evidence records.
