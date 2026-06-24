# Task 1 Review Report — proxy / remote mode for `@termbridge/mcp-server`

Branch: `m9-browser-watch`  
Commit: `757e0c9`  
Reviewer: Claude Sonnet 4.6 (automated)

---

## 1. Spec compliance checklist

| Requirement | Status | Notes |
|---|---|---|
| `createRemoteCaller(opts)` exported from `remote.ts` | ✅ | Correct signature |
| POSTs to `${serverUrl}/api/tool/${name}?token=${encodeURIComponent(token)}` | ✅ | Line 114 |
| JSON body = args | ✅ | `JSON.stringify(args ?? {})` |
| Parses `{ok, data, error}` outer envelope | ✅ | Line 119 |
| THROWS on outer `!ok` | ✅ | Line 120 |
| Returns `data` on outer `ok` | ✅ | Line 121 |
| `createRemoteToolSpecs(caller)` exported | ✅ | Line 128 |
| Reuses `createToolSpecs(new SessionManager())` for name/description/inputSchema only | ✅ | Lines 129–134 |
| Swaps each handler to `(args) => caller(name, args)` | ✅ | Line 133 |
| `createServer` gains `remote?: {serverUrl, token}` | ✅ | `server.ts` line 13 |
| When `remote` set: registers REMOTE specs | ✅ | `server.ts` line 17–18 |
| When `remote` unset: today's in-process behaviour preserved byte-for-byte | ✅ | Lines 18–19 |
| `formatTextResponse`/`formatErrorResponse` wrapping unchanged | ✅ | Same `server.ts` block |
| `runServer` reads `TERMBRIDGE_SERVER_URL` + `TERMBRIDGE_TOKEN` | ✅ | `stdio.ts` lines 12–14 |
| Passes `remote` only when URL is set | ✅ | Line 14 |
| `index.ts` exports new API | ✅ | Lines 5–6 |
| Test 1: URL + body + inner-data on outer-ok | ✅ | `remote.test.ts` lines 14–28 |
| Test 2: throws on outer `!ok` | ✅ | Lines 30–39 |
| Test 3: inner `human_driving` stays data | ✅ | Lines 41–54 |

All 19 spec requirements are met.

---

## 2. Global constraints checklist

| Constraint | Status | Notes |
|---|---|---|
| Proxy mode must NOT construct a session-RUNNING SessionManager | ✅ | Throwaway manager never opened/started |
| Throwaway manager acceptable for schemas only | ✅ | But see finding #1 below |
| `TERMBRIDGE_SERVER_URL` unset = in-process behaviour byte-for-byte | ✅ | Conditional in `stdio.ts` line 14; `server.ts` ternary preserves old path |
| Existing tests untouched | ✅ | No modifications to `tools.test.ts`, `server.adversary.test.ts` |
| Remote caller keys ONLY on outer `{ok}` | ✅ | `j.ok` check; inner envelope returned as-is |
| `send_text` inner `{ok:false,error:"human_driving"}` passes through as data | ✅ | Confirmed by test 3 |
| TS NodeNext strict, `.js` import extensions | ✅ | All imports use `.js` |
| Bun test runner | ✅ | `bun:test` |
| No new deps | ✅ | `fetch` is global |

---

## 3. Findings

### Finding 1 — Important: Throwaway `SessionManager` in `createRemoteToolSpecs` has a real filesystem side effect

**File:** `packages/mcp-server/src/remote.ts`, line 36  
**Code:** `return createToolSpecs(new SessionManager()).map(...)`

The comment above this line claims "The throwaway manager is never opened (no tmux/observer); in proxy mode `TERMBRIDGE_HOME` is unset so its construction has no side effects."

This is **inaccurate**. The `SessionManager` constructor in `packages/core/src/manager.ts` line 276 calls `resolveDefaultPipeDir()` unconditionally, regardless of `TERMBRIDGE_HOME`:

```ts
// manager.ts lines 185–192
function resolveDefaultPipeDir(): string {
    const fromEnv = process.env.TERMBRIDGE_PIPE_DIR;
    if (fromEnv) {
        mkdirSync(fromEnv, { recursive: true });
        return fromEnv;
    }
    return mkdtempSync(join(tmpdir(), "termbridge-"));  // always runs
}
```

So every call to `createRemoteToolSpecs` (i.e., every proxy-mode server startup) creates a temporary directory under the OS temp folder and **leaks it** (never cleaned up). This is a resource leak, not a correctness bug — the proxy mode still functions correctly because that `pipeDir` is never used — but:

1. The comment is misleading: construction is not side-effect-free.
2. On long-lived processes or frequent restarts, temp directories accumulate.

**Severity:** Important (resource leak + misleading comment; not a correctness failure for the proxy path)

**Fix:** Either (a) pass a `pipeDir` option pointing to an already-existing path, (b) pass a no-op `envFactory` to skip the real one, or (c) at minimum correct the comment. The minimal correct fix is:

```ts
// Option: skip real pipeDir by providing a no-op envFactory
return createToolSpecs(new SessionManager({
    pipeDir: "/tmp",           // any existing path; never used in proxy mode
    envFactory: () => { throw new Error("proxy mode: envFactory must not be called"); },
})).map(...)
```

Or simply acknowledge the leak in the comment.

---

### Finding 2 — Minor: `TERMBRIDGE_TOKEN` defaults to `""` when unset in proxy mode

**File:** `packages/mcp-server/src/stdio.ts`, line 13  
**Code:** `const token = process.env.TERMBRIDGE_TOKEN ?? "";`

When `TERMBRIDGE_SERVER_URL` is set but `TERMBRIDGE_TOKEN` is not, `runServer` silently enters proxy mode with an empty token. The server-side `guard.ts` treats an empty `token` query param as unauthenticated and will reject the request (if the server was started with a token). This is not incorrect — it will fail loudly at request time — but a warning on startup would be more operator-friendly.

**Severity:** Minor (fail-fast behaviour; no silent data corruption)

---

### Finding 3 — Minor: No test for `createRemoteToolSpecs` schema pass-through

The spec required a test for `createRemoteToolSpecs`, specifically that it correctly mirrors the name/description/inputSchema and swaps handlers. The three tests in `remote.test.ts` only test `createRemoteCaller`. The `createRemoteToolSpecs` function is exercised only indirectly (via `createServer` in existing adversary tests, if those are re-run on the proxy path — which they are not).

The spec says "3 tests" and all three are for `createRemoteCaller`, so this is within the spec's literal test requirement. However, a test for `createRemoteToolSpecs` (e.g., that it returns the same count of specs with the same names, and that handlers call the caller with the right name) would prevent regressions.

**Severity:** Minor (spec permits 3 tests, all present; gap is an improvement opportunity)

---

### Finding 4 — Minor: HTTP status code not checked before JSON parse

**File:** `packages/mcp-server/src/remote.ts`, lines 119–121

```ts
const j = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
if (!j.ok) throw new Error(j.error ?? `tool ${name} failed (${res.status})`);
return j.data;
```

If the server returns a non-JSON error (e.g., a 502 Bad Gateway from a reverse proxy, or a 500 with an HTML body), `res.json()` will throw a SyntaxError with a confusing message like "Unexpected token '<'". The fallback message `tool ${name} failed (${res.status})` is available only after `res.json()` has already thrown.

The outer-`ok`-only keying is correct per spec; this is purely a robustness/DX issue for failure cases not covered by the spec.

**Fix:**
```ts
let j: { ok: boolean; data?: unknown; error?: string };
try {
    j = (await res.json()) as typeof j;
} catch {
    throw new Error(`tool ${name} failed (${res.status}): response was not JSON`);
}
```

**Severity:** Minor (only affects out-of-band failure paths; not tested by spec)

---

### Finding 5 — Observation: `server.adversary.test.ts` comment/assertion mismatch (pre-existing)

The file header (line 7) says "exactly the 11 §6 tools" but the actual assertion at line 375 checks `toHaveLength(13)`. This is a pre-existing inconsistency, not introduced by this task.

---

## 4. Positive observations

- **Envelope semantics are exactly right.** `j.ok` is the sole branch point; `j.data` is returned wholesale whether it contains `{ok:false}` or anything else. Test 3 is a meaningful, non-vacuous regression guard for the `human_driving` passthrough requirement.
- **Trailing-slash handling.** `opts.serverUrl.replace(/\/$/, "")` correctly normalises URLs with or without trailing slash — not required by spec but a good defensive touch.
- **`encodeURIComponent` on token.** Correct and confirmed round-trip-safe: the server uses `new URL(url).searchParams.get("token")` which auto-decodes.
- **Existing in-process path is byte-for-byte unchanged.** The ternary in `createServer` and the `serverUrl ?` conditional in `runServer` ensure `TERMBRIDGE_SERVER_URL` unset is a strict no-op to prior behaviour.
- **Test assertions are real.** All three tests capture meaningful invariants (URL shape, body shape, return value shape, throw message content) rather than vacuous `toBeTruthy()` style checks.
- **TypeScript types are sound.** `RemoteOptions`, `RemoteCaller` exported types are clean; `fetchImpl?: typeof fetch` correctly types the injected stub.
- **No new dependencies.** Global `fetch` is used; Bun provides it natively.
- **`.js` extensions throughout.** NodeNext-compliant on all new imports.

---

## 5. Summary verdict

**SPEC COMPLIANCE: ✅ — all 19 requirements met.**

**CODE QUALITY: changes-needed** — one Important finding (resource leak + misleading comment in `createRemoteToolSpecs`; the throwaway `SessionManager` does create a temp dir on every proxy-mode startup). Three Minor findings (empty-token silent proxy, no `createRemoteToolSpecs` test, non-JSON error handling). The core logic is correct and the critical envelope/human_driving semantics are exactly right.
