# M9 browser-watch — progress ledger

Branch: m9-browser-watch  Base: 18e3585


Task 1 (MCP proxy mode): complete (commits 18e3585..12b1450, review clean after pipeDir-leak fix).
  Minor findings carried to final review:
   - stdio.ts: TERMBRIDGE_SERVER_URL set but TERMBRIDGE_TOKEN unset → empty token, fails at request time (fail-fast; a startup warn would be friendlier).
   - remote.ts: res.json() on a non-JSON 5xx (reverse-proxy HTML) throws a confusing SyntaxError; wrap to "(status): not JSON".
   - (pre-existing) server.adversary.test.ts header says "11 tools" but asserts 13 — stale comment.

Task 2 (watch e2e smoke): complete (commit 95d82a4, self-review clean; build+typecheck green; run deferred to a docker laptop).

Task 3 (publish @termbridge/server): complete (commits 95d82a4..53bcdd6; dry-run booted via bunx + served client; review SPEC ✅ QUALITY approved; fixed double-build + test-files-in-tarball).

Task 4 (setup.sh --watch): complete (commit ca9762c + test harness; self-review clean; 9/9 stub asserts). Implementer fixed a real plan bug (${VAR:+KEY=val} before nohup doesn't set env → used `env $_WATCH_ENV`).
  Minor for final review: `env $_WATCH_ENV` word-splits — a token VALUE containing a space would break (tokens don't, so OK).

Task 5 (skill posts watch URL): complete (self-review clean — blockquote placed after step-1 open_session, before step 2, correct style).
