# Benchmark fixtures

Four pinned, licensed, redistributable repositories host the 20 benchmark cases in
`../manifest.json`. Pinning date: 2026-07-27. **Candidate fixtures may be documented
separately, but placeholders never count toward the gate** — every row below was
resolved against the live repository on the pinning date.

## Pinning method

| Field | Method |
|---|---|
| `commit_sha` | `git rev-parse HEAD` of the default branch on the pinning date |
| `license` | SPDX identifier read from the repo's `LICENSE`/`license` file |
| `content_sha256` | `git archive --format=tar <commit_sha> \| shasum -a 256` (deterministic per commit) |
| `image` | `docker pull oven/bun:1.3.5` then `docker inspect --format='{{index .RepoDigests 0}}'` |

Re-verification: clone the repo, check out `commit_sha`, re-run the archive hash, and
compare with `manifest.json`. Any drift fails the manifest test (and therefore the
Phase 0 gate, P0.6).

## The fixtures

| id | Repository | Covers | License |
|---|---|---|---|
| `mitt` | [developit/mitt](https://github.com/developit/mitt) | localized fixes (tiny single-purpose library with a test suite) | MIT |
| `slugify` | [sindresorhus/slugify](https://github.com/sindresorhus/slugify) | multi-file features, configuration changes, security validation (string handling with edge-case tests) | MIT |
| `lowdb` | [typicode/lowdb](https://github.com/typicode/lowdb) | API changes, migrations, diagnosis (small but real persistence API) | MIT |
| `html5-boilerplate` | [h5bp/html5-boilerplate](https://github.com/h5bp/html5-boilerplate) | frontend/E2E and configuration work (static site, no build step) | MIT |

Container image for all fixture runs: `oven/bun:1.3.5`, pinned in the manifest by
digest (`oven/bun@sha256:e90cdbaf…8ec3`).

## Sentinel values in the manifest

Two `runtime` fields describe infrastructure that does not exist yet at Phase 0 —
recorded honestly, not fabricated:

- `adapter_version: "0.0.0-unbuilt"` — the `CodingCliDriver` adapters land in
  Phase 2 (Tasks 14–15). Until then there is no adapter version to record.
- `adapter_schema_hash: fc31b4d7…d7d7` — SHA-256 of the literal string `unbuilt`
  (`echo -n unbuilt | shasum -a 256`). A real driver-event schema hash replaces
  this sentinel when Task 8 freezes the schema and Task 25 first runs the matrix.
- `termbridge_sha` — the repository SHA at manifest authoring
  (`2cb9654068573a9cadb6d9a757fea2c8f65839d0`); bumped with each manifest version.
- `cli_build: "claude 2.1.220; opencode 1.18.7"` — versions installed on the
  authoring host on the pinning date; the runner records the actual binaries used.
- `grader` commands naming `scripts/benchmark-grade.ts` — the deterministic grader
  entry point delivered by Task 25; the manifest declares its interface
  (`--case <id>`, exit 0 = pass) ahead of the implementation.
