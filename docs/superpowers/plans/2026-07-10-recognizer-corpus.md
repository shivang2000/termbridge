# P2.1 — Recognizer fixture corpus (TDD plan)

## Task 1: Scaffold fixtures + guard (red)

- [ ] Create `__fixtures__/` dirs + sample `.txt` files from existing tests
- [ ] Create `corpus.guard.test.ts` that asserts each fixture matches
- [ ] Run: guard tests pass once fixtures land

## Task 2: Full corpus

- [ ] claude-permission (incl. live 2.1.183 captures)
- [ ] rate-limit, oauth-url, generic-yn, claude-activity, tb-marker
- [ ] README for re-capture

## Task 3: Verify

- [ ] `bun run test` / typecheck / lint green
- [ ] CHANGELOG + ROADMAP

## Files

- `packages/core/src/recognizers/__fixtures__/**`
- `packages/core/src/recognizers/corpus.guard.test.ts`
- `docs/superpowers/specs/2026-07-10-recognizer-corpus-design.md`
