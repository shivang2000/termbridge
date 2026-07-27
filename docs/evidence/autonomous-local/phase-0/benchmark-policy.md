# Benchmark budget policy — Autonomous Local

> **Status:** Declared (Phase 0, Task 3) — before any benchmark execution
> **Date:** 2026-07-27 · **Owner:** Termbridge maintainer
> **Authority for numbers:** `benchmarks/autonomous-local/manifest.json` (`budget` block) — this
> document is the prose contract; the manifest is the machine-checkable one.

## Per-CLI ceilings (declared in advance)

| Ceiling | Value | Where declared |
|---|---|---|
| Wall-clock, full stable matrix per CLI | 1800 minutes (30 h) | `budget.per_cli_wall_clock_minutes` |
| Provider cost, full stable matrix per CLI | USD 150 | `budget.per_cli_cost_ceiling_usd` |
| Per-case wall-clock limit | 1800–2700 s (per case `time_limit_seconds`) | each case |
| Per-case provider-cost ceiling | USD 5–10 (per case `cost_ceiling_usd`) | each case |
| Per-case elapsed/usage budget | `elapsed_seconds_max`, `usage_proxy` | each case |

**Exceeding a ceiling blocks the candidate or requires a new manifest version. A ceiling is never
retroactively raised to fit a result.** Any change to a ceiling, a fixture pin, or a case is a new
`schema_version`-tracked manifest revision with a dated rationale; results are always reported
against the manifest version that produced them.

## Infrastructure-invalid rerun rate cap

Declared as a manifest field, not runner prose: `budget.infrastructure_invalid_rerun_rate_cap = 0.1`.

A run classified `retryable` by its case's `infrastructure_invalid_classification` may be rerun, but
reruns may not exceed 10% of total attempts in a matrix run. Runs classified `excluded_from_score`
or `counted` follow their label. The runner reports the rerun rate per matrix run; exceeding the
cap invalidates the run, it does not raise the cap.

## Run modes (roadmap §10)

1. **Stable matrix** — 20 cases × 3 clean attempts × 2 required CLIs. This is the only mode that
   sets the stable score (each CLI needs ≥54/60; every `critical_scenario` needs 3/3 — aggregate
   completion never masks a critical failure).
2. **Latest-upstream canaries** — the same cases against the newest upstream CLI builds, run
   separately and reported separately. A canary failure never auto-expands the supported version
   range; expanding support requires a screen-fixture review and a manifest/decision update.
3. **Nightly smoke** — one attempt per case. A drift signal only; it never substitutes for the
   stable matrix and never gates a release.

## Fixture integrity

The four fixtures are pinned by commit SHA, SHA-256 content hash (`git archive` of the commit),
SPDX license, and container image digest (see `benchmarks/autonomous-local/fixtures/README.md`).
Re-verification failure or drift is a benchmark-blocking defect, classified per the case's
`infrastructure_invalid_classification` — it never justifies editing a pin in place.
