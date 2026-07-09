# P2.1 — Recognizer screen fixture corpus (design)

## Context

Recognizer patterns (`claude-permission`, `claude-activity`, `oauth-url`,
`generic-yn`, `rate-limit` → kind `rate_limited`, `tb-marker`) track the Claude
Code TUI and are **version-fragile by design**. Today fixtures live as inline
string constants in `*.test.ts`. ROADMAP P2.1 wants a regression corpus of
screen captures that fails loudly on drift.

## Decision

**Approach A — file corpus + guard suite (no pipeline API change).**

1. Store positive-match screens under
   `packages/core/src/recognizers/__fixtures__/<recognizer-dir>/*.txt`.
2. Add `corpus.guard.test.ts` that loads every `*.txt`, routes by directory to
   the matching `Recognizer`, and asserts `match(screen, "")` is non-null with
   the expected `kind`.
3. Keep existing unit + adversary tests (API edge cases stay inline/synthetic).
4. Document re-capture in `__fixtures__/README.md`.
5. **Declarative DSL deferred** — corpus first; thin data-driven matchers later
   behind the same `Recognizer` interface if needed.

## Rejected

- **B — Jest/Vitest snapshots:** not used in this repo (Bun test).
- **C — Full declarative rewrite of all recognizers:** high risk, not needed for
  drift detection; corpus gives the alert.

## Non-goals

- Breaking `Recognizer` / `RecognizerPipeline`.
- Live cloud/tmux in unit tests (fixtures are static).
- Renaming event kind `rate_limited` (module stays `rate-limit.ts`).

## Acceptance

- `bun test` in core: corpus.guard green; all prior recognizer tests green.
- Missing/broken fixture → clear failure naming path + recognizer kind.
