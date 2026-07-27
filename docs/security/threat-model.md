# Termbridge Local — Threat Model

> **Status:** Accepted (Phase 0, Task 2C)
> **Date:** 2026-07-27 · **Owner:** Termbridge maintainer
> **Review trigger:** every phase gate, and any change to trust boundaries, credentials, or egress
> **Authorities:** design §3.2 (trust zones) and §10 (security), roadmap §11, `scripts/gate-check.ts`

This model covers the open-source, single-user, loopback-hosted Termbridge Local daemon. It does not
cover Termbridge Platform (multi-user OIDC, Postgres, remote workers), which has its own threat model
before any Platform gate may pass.

## Scope, assets, actors, and boundaries

**Assets.** Subscription credentials (Claude Code, OpenCode/provider), tracker OAuth credentials
(Jira, Linear), GitHub App private key and installation tokens, webhook signing secrets, repository
contents, task evidence and transcripts, and the operator's host itself.

**Actors.** The operator (trusted, present for approvals); the driven coding CLI (constrained —
Claude Code or OpenCode acting inside a task workspace); the trackers and the forge (external,
authenticated, but their *content* is untrusted input); and the **untrusted issue author** — anyone
who can file or comment on a Jira/Linear issue that a configured workflow state pulls into intake.

**Boundaries.** Loopback management HTTP + SSE; the MCP stdio channel; the sandbox/environment
substrate (local tmux, Docker, E2B); the Git worktree; the browser session; and the public webhook
ingress (the only non-loopback listener).

**Standing rule.** Issue text, comments, attachments, repository files, and command output are
untrusted input everywhere. **Prompt injection reaching a privileged operation is the
highest-severity path in this product**, and prompt-level defenses never grant authorization:
policy, sandboxing, independent verification, independent review, exact-hash delivery, and the
absence of merge/deploy capabilities are what enforce the boundary (design §10.4).

## Local daemon

**Threats.** Theft or replay of the management API token; CSRF and DNS-rebinding against the
loopback listener; WebSocket origin forgery; a coding runtime reading or mutating daemon state
(SQLite, journals, secret store); daemon death mid-operation leaving an unprovable effect.

**Existing mitigation.** Management API binds loopback-only and requires an installation-generated
token; `Origin`/`Host` validation and CSRF protection on mutations; secure browser sessions with no
persistent tokens in URLs; reauthentication for approval, cancellation, credential, and cleanup
operations (design §10.3). SQLite is authoritative and every consequential effect is journaled
`prepared → dispatched → confirmed`, with unprovable outcomes entering `uncertain`; startup
reconciliation replays the journal (design §9). WebSocket is reserved for live terminal bytes and
interactive attachment — application events flow only over SSE.

**Residual risk.** Token compromise of a same-user process is out of scope (loopback + single user
trusts the operator's account). Remote access is unsupported unless the operator deliberately fronts
the daemon with an authenticated TLS proxy.

**Holding tests/gates.** Phase 1 gate P1.7 (`ws-authorization.test.ts`: exact-origin validation,
per-message authorization, no application events over WS); Phase 1 gates P1.1/P1.3 (crash matrix,
event replay across restart); release gate R.2e (fault suite over every journal boundary).

## CLI adapter

**Threats.** Prompt injection from issue text, repository files, or command output steering the
coding CLI toward privileged action; the CLI attempting to approve its own plan, waive policy,
declare verification complete, or deliver to GitHub; credential exfiltration from the runtime
environment; upstream CLI behavior drift breaking recognizer/permission assumptions.

**Existing mitigation.** The coding agent cannot authorize its own plan, waive policy, declare
verification, or deliver (design §3.2); a verified human approves the exact plan hash, issue
snapshot hash, base SHA, and policy version before any writable workspace exists. Control-plane
credentials never enter the coding runtime (design §10.1); the runtime receives only its own minimum
credential in an ephemeral, isolated environment. OpenCode runs with Plan-mode bash denial plus the
outer read-only boundary; the post-plan sensitive-effect gate blocks credentials and destructive
commands. Redaction runs before persistence and before every egress.

**Residual risk.** Injection cannot be eliminated, only bounded — see Accepted risks §1. Upstream
CLI drift is continuous; the supported-version canary lane detects but cannot prevent it.

**Holding tests/gates.** Phase 2 gates P2.2 (containment: denied paths, sandbox policy, egress,
Plan-mode bash denial) and P2.4 (`GH_TOKEN`, `GH_HOST`, tracker/GitHub App credentials absent from
both runtimes); Phase 4A gates P4A.4/P4A.4b; release gate R.5 (zero prohibited-operation findings).

## Sandbox

**Threats.** Escape from the environment substrate to the host (Docker socket, host process
namespace, daemon home directory); cross-workspace access between concurrent tasks; network egress
beyond the declared policy; resource exhaustion by a runaway or adversarially steered process.

**Existing mitigation.** Task work happens in managed, locked worktrees prepared by the workspace
manager; the backend-neutral environment contract (create, start, send, capture, resize, kill,
reconcile) is conformance-tested across Local, Docker, and E2B; denied-path enforcement runs before
execution; provider sandboxes (E2B) isolate the runtime from the operator's host entirely.

**Residual risk.** The **Local** environment (host tmux) is a convenience boundary, not a security
boundary — it runs with the operator's privileges minus credential scoping. The design deliberately
tests upstream authentication and subprocess behavior rather than claiming perfect containment
(design §10.1). Operators handling hostile input should select Docker or E2B.

**Holding tests/gates.** Phase 1 gate P1.9 (environment conformance — fails without `E2B_API_KEY`);
Phase 2 gate P2.2 (sandbox policy honored, no egress beyond declared policy); release gate R.2e.

## Git

**Threats.** Malicious repository hooks executing on the host during clone/fetch/commit; symlink
escapes and path traversal writing outside the task workspace; submodule protocol abuse
(`file://`, `ssh://`); poisoned global Git config or credential helpers leaking host credentials;
branch tampering by a human or another tool mid-task; a dirty worktree on daemon resume.

**Existing mitigation.** Workspace preparation controls Git hooks, global configuration, credential
helpers, submodule protocols, symlink escapes, path traversal, writes outside the workspace, and
access to daemon state, other worktrees, and the Docker socket (design §10.4). Repositories are
deterministic local mirrors with locked per-task worktrees (no shared mutable checkout). External
branch modification pauses the task — never a force push. Final delivery validates changed paths,
symlinks, submodules, secret canaries, binary/oversized artifacts, candidate/evidence hashes, and
commit identity.

**Residual risk.** Hooks in long-lived *mirrors* are trusted after first verification; a mirror
poisoned between verification and use would be caught at delivery validation, not at fetch.

**Holding tests/gates.** Phase 3 gate P3.4 (final-diff scanner: symlinks, submodules, binaries,
oversized artifacts, denied paths, `allowed_paths` violations); Phase 4A gate P4A.3 (branch
tampering pauses); Phase 2 gate P2.3 (interrupted dirty-worktree tracer evidence).

## Forge

**Threats.** GitHub App private key or installation token leakage; an over-privileged App
installation; forged or replayed webhook deliveries; duplicate or out-of-order deliveries creating
duplicate pushes or PRs; delivery of an untested or unreviewed SHA; capability creep toward ready,
approve, merge, bypass, or deploy operations.

**Existing mitigation.** User-owned GitHub App with least-privilege validation at installation.
The public webhook endpoint is separate from the management API and enforces request-size limits,
raw-body signature validation with constant-time comparison, timestamp freshness, delivery
deduplication, and receipt-before-acknowledgement (design §10.2). Delivery is exactly one draft PR
whose head equals the verified and required-reviewed SHA; crash and reconciliation matrices cover
every commit/push/PR boundary. `DRAFT_PR_READY_FOR_HUMAN` is the only successful terminal state —
ready, approve, merge, bypass, and deploy do not exist in the application or adapter contracts.

**Residual risk.** Required-check observation depends on repository rulesets the forge cannot
prove; branch/ruleset inspection detects but cannot prevent an administrator weakening them.

**Holding tests/gates.** Phase 4A gates P4A.1 (exactly-one delivery crash matrix), P4A.2 (no
merge-equivalent operation — compile-time and route-registry assertions), P4A.4; Phase 4B/4C gates
×2 (duplicate/out-of-order intake); release gate R.5.

## Browser

**Threats.** Session hijack of the dashboard; token leakage through URLs, logs, or screenshots;
injection of attacker-controlled terminal content into the page (pane bytes, activity feed, issue
text rendered as HTML); confusion between human and agent control leading to the agent typing over
the human.

**Existing mitigation.** Secure browser sessions, no persistent tokens in URLs, CSRF protection,
and reauthentication for sensitive operations (design §10.3). Terminal bytes render through
xterm.js as text, not HTML; the activity feed and any rendered issue content must be escaped.
WriteLock gives an explicit human-drives/agent-drives boundary: human input revokes agent writes
until the window lapses, and a takeover is announced rather than silent (V1 behavior, retained).

**Residual risk.** Any future rich-rendered content (diff views, Markdown plan bodies) expands the
injection surface; each new renderer must be listed here at the next review.

**Holding tests/gates.** Phase 1 gate P1.7 (WS boundary: unauthenticated upgrades rejected, no
task-state influence from WS clients); Phase 2 gate P2.5 (takeover and return-to-agent suite).


## Supply chain

**Threats.** Compromised npm dependencies or install scripts; unpinned or drifted container images;
upstream CLI releases changing behavior silently; benchmark fixtures with unknown provenance or
license; build/release artifacts that cannot be tied back to source.

**Existing mitigation.** `bun.lock` with `--frozen-lockfile` in CI; benchmark fixtures pinned by
commit SHA, SHA-256 content hash, SPDX license, and container image digest (placeholders never
count); a supported-version canary lane that runs latest-upstream releases separately and never
auto-expands the supported range; SBOM, provenance attestation, and dependency review attached to
every stable candidate and gating in CI.

**Residual risk.** The coding CLIs are themselves frequently-updated upstream binaries; pinning is
partial and the canary lane is detection, not prevention — see Accepted risks §4.

**Holding tests/gates.** Phase 0 gate P0.6 (manifest schema: ≥4 pinned licensed fixtures, 20
cases, 18 critical scenarios); release gates R.7 (SBOM/provenance/dependency review) and R.3/R.4
(benchmark thresholds, including canary separation).

## Accepted risks

Tracked per the defer policy (roadmap §15); each must not be described as mitigated.

1. **Prompt injection is bounded, not eliminated.** A sufficiently crafted issue or repository can
   still steer the coding CLI's *local* behavior; authorization never comes from prompt defenses.
   Owner: Termbridge maintainer. Reason: no known technique proves injection-freedom; the product
   boundary (no self-approval, no delivery, independent verification/review, exact-hash delivery)
   is the control. Next review: 2026-10-27 or at the Phase 2 gate, whichever is earlier.
2. **The Local environment is not a security boundary.** Host tmux runs with the operator's
   privileges minus credential scoping. Owner: Termbridge maintainer. Reason: single-user loopback
   product; Docker/E2B are the documented choice for hostile input. Next review: 2026-10-27.
3. **Remote access to the management API is unsupported.** Accepted as scope, not as a defect.
   Owner: Termbridge maintainer. Reason: design §10.3 requires an operator-provided authenticated
   TLS proxy; first stable release is loopback-only. Next review: at the Platform phase plan.
4. **Upstream CLI drift.** Claude Code and OpenCode are moving targets; structured surfaces may
   appear or change. Owner: Termbridge maintainer. Reason: the canary lane and Task 7's
   structured-surface brief bound but do not remove this. Next review: 2026-08-27, and after any
   upstream major/minor release that changes a frozen schema hash.

