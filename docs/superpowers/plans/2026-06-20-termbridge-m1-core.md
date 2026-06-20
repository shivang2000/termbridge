# M1 — core + Local (milestone plan)

Authority: `docs/superpowers/specs/2026-06-18-termbridge-design.md` §5.1, §6, §9, §10.
Master plan: see the approved implementation plan (M1–M6). This doc is the executable extract for M1.

## Goal

Ship `@termbridge/core`: the framework-agnostic library that opens and pilots a **Local** tmux session
like a human. No MCP, no HTTP, no node-pty (those are M3/M5). All units compile against the contracts
already committed in `packages/core/src/types.ts`.

## Build order

**Stage A — leaf units (independent, built in parallel, TDD).** Each owns disjoint files; each is
driven test-first then a second agent adversarially tries to break it.

1. **tmux helpers** — `src/tmux/helpers.ts` (+ `helpers.test.ts`)
   - Wrap the tmux CLI through an injectable `ExecFn` (default `node:child_process execFile`) so tests
     mock the process (spec §10.1). No real tmux in unit tests.
   - Functions: `newSession({name,cwd,cmd?,cols,rows,env?})` → `tmux new-session -d -s <name> -x <cols>
     -y <rows> -c <cwd> [cmd]` with **default cols 500** (wide so OAuth URLs never hard-wrap);
     `sendKeys(name, keys, {literal?})`; `sendControl(name, key)`; `capturePane(name,{scrollback?})` →
     `capture-pane -p -t <name> [-S -<n>]`; `pipePaneStart(name, file)` → `pipe-pane -O -t <name>
     'cat >> <file>'`; `hasSession(name)`; `killSession(name)`; `listSessions()`; `resizeWindow(name,
     cols, rows)`.
   - Tests assert exact argv passed to the mock `ExecFn` and correct parsing of `listSessions`/`hasSession`.

2. **WriteLock** — `src/session/write-lock.ts` (+ test)
   - State machine `agent | human-active` with an injectable `Clock`. `noteHumanActivity()` flips to
     `human-active` and stamps the time; `state()` returns `human-active` until `ttlMs` (default 3000)
     after the last human activity, else `agent`. `tryAgentWrite()` → `{ok:true}` when `agent`, else
     `{ok:false, error:"human_driving"}` (never throws, spec §9).
   - Tests drive the clock to assert the flip, the TTL expiry back to `agent`, and rejection while active.

3. **recognizers** — `src/recognizers/{url-detector.ts, oauth-url.ts, pipeline.ts}` (+ tests)
   - Port `alertforge .../url-detector.ts` and its test **verbatim** (pure `detectOAuthPrompt`,
     `detectDeviceCode`). Keep the biome-ignore ANSI-regex comments.
   - `oauth-url.ts`: a `Recognizer` (`kind:"oauth-url"`) whose `match(screen,bytes)` runs the detector
     over `screen` and returns `{data:{url, code?}, suggestedKeys:[]}` or null.
   - `pipeline.ts`: `RecognizerPipeline` — `register(r)`, `process(screen,bytes) → RecognizedEvent[]`
     (runs each recognizer, tags with `kind`, dedupes identical consecutive events).

4. **PtyObserver** — `src/observer/pty-observer.ts` (+ test)
   - Given an `Environment` (for `tmux pipe-pane`) and a temp file path, starts piping pane output,
     tails appended bytes, and maintains: a rolling buffer with monotonic byte offsets, `lastActivityAt()`
     (updated on every chunk — powers `waitForIdle`), `onData(cb)`, `buffer(sinceOffset)→{data,nextOffset}`,
     `stop()`.
   - Unit-tested against a **scripted byte stream** (inject a fake tail source / fs poller) — no real
     tmux. Assert the activity clock advances on data and `buffer(offset)` returns only the new slice.

**Stage B — integration (depends on Stage A; runs on `main`).**

5. **LocalEnvironment** — `src/env/local.ts`: implements `Environment` over the tmux helpers on the host.
   `kind:"local"`. `attachPty` left unimplemented (throws "implemented in M5").
6. **Session** — `src/session/session.ts`: composes Environment + PtyObserver + RecognizerPipeline +
   WriteLock. Implements `sendText(text,{enter})` (gated by WriteLock; emits `human_took_over` event when
   rejected), `sendControl(key)`, `readScreen({scrollback})`, `readNewOutput({sinceOffset})`,
   `waitForIdle(quietMs=400,timeoutMs=30000)` (polls `lastActivityAt`), `waitForText(pattern,timeoutMs)`,
   `readEvents({sinceOffset})`, `resize(cols,rows)`, `close()`. **`wait_for_*` never hang** — on timeout
   return `{idle:false}`/`{matched:false}` + last screen (spec §9).
7. **SessionManager** — `src/manager.ts`: `open(opts)→Session`, `get(id)`, `list()→SessionInfo[]`,
   `close(id)`. Concurrency cap from `TERMBRIDGE_MAX_SESSIONS` (default 4); opening past the cap rejects
   cleanly. Generates session ids/names; selects Environment by `opts.env` (`local` only in M1).
8. Extend the barrel `src/index.ts` to export the new units.

## Verification

- `bun install && turbo run test lint typecheck` green.
- **Smoke** (`scripts/smoke-m1.ts`, real tmux): `SessionManager.open({env:"local"})` →
  `sendText("echo hi",{enter:true})` → `waitForIdle()` → `readScreen()` contains `hi`; then
  `sendText("sleep 30")` + `sendControl("C-c")` returns the prompt. Cleans up with `close()`.

## Ship

Commit logical units (helpers / write-lock / recognizers / observer / env+session+manager / smoke),
conventional + `Constraint:`/`Rejected:`/`Confidence:` trailers + `Co-Authored-By`. Push `origin/main`.
**Pause for review before M2.**

## Notes / risks
- `noUncheckedIndexedAccess` is on — index access must be guarded (the ported detector already does).
- tmux ≥3.0 needed for `pipe-pane -O` (host has 3.5a ✓).
- Leaf agents run `bun test <file>` in isolation with **no node_modules** (core has zero runtime deps);
  typecheck/lint run in the integration pass where deps are installed.
