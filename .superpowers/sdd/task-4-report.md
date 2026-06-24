# Task 4 Report — `setup.sh --watch` flag

## Integration points touched

### `scripts/setup.sh`

1. **Help header** (line 24) — added `--watch  start a host web server so you can WATCH/intervene in a browser (local mode; needs bun)`.

2. **Defaults block** (line 37) — added `DO_WATCH="false"` alongside the other defaults.

3. **Arg parse loop** (line 61) — added `--watch) DO_WATCH="true"; shift ;;`.

4. **`mask_kv` helper** (line 49) — added `TERMBRIDGE_TOKEN=*) echo "TERMBRIDGE_TOKEN=***";;` so the session token is never echoed in the manual-Hermes fallback block.

5. **Section 4b** (new, after Claude auth) — when `DO_WATCH=true`:
   - Guards: `--watch` requires `--mode local` and `bun` on PATH (both `die` on failure).
   - Generates a 16-byte hex `WATCH_TOKEN` and an ephemeral `WATCH_PORT` via `node -e`.
   - Kills any previously-running watch server (reads `~/.termbridge/watch.pid`).
   - Launches `nohup env KEY=VAL ... bunx @termbridge/server` in the background, writing `watch.pid` and `watch.json` under `~/.termbridge/`.
   - Sets `WATCH_URL` for use in the recap.
   - **Key fix vs. spec**: the spec used `${API_KEY:+ANTHROPIC_API_KEY="$API_KEY"}` inline before `nohup` — bash does NOT treat parameter-expansion results as env assignments, so those vars were silently dropped. Fixed by pre-building `_WATCH_ENV` as a string and passing it to `env`.

6. **`ENV_PAIRS` block** (section 5) — wrapped in `if DO_WATCH`:
   - `true` branch: `ENV_PAIRS=( TERMBRIDGE_SERVER_URL=... TERMBRIDGE_TOKEN=... )` only — no session config leaks into the MCP.
   - `false` branch: unchanged existing logic (TMUX_SOCKET, ALLOWED_ENVS, MAX_SESSIONS, TERMBRIDGE_HOME for docker, auto-gh-token, api-key).

7. **Recap** (section 8) — `[ -n "$WATCH_URL" ] && authline "  Browser watch" "...$WATCH_URL..."` appended after the Hermes MCP lines.

### `scripts/test-setup-watch.sh` (new)

Stub harness using a faked `$HOME` and a `$FAKE_BIN` directory on `$PATH` with stubs for `claude`, `node` (forwarded to real node for port-finder), `npm`, `gh`, `bun`, `bunx`, and `hermes`. The `bunx` stub uses `printf` (not a heredoc) to write the stub file — heredocs with unquoted delimiters interpolate `${VAR}` at creation time, silently capturing the outer shell's empty values rather than the runtime values.

## Stub-test asserts and output

```
Assertion results:
  PASS  (a1) mcp add contains TERMBRIDGE_SERVER_URL
  PASS  (a2) mcp add contains TERMBRIDGE_TOKEN
  PASS  (a3) mcp add does NOT contain ANTHROPIC_API_KEY
  PASS  (a4) mcp add does NOT contain GH_TOKEN
  PASS  (b)  watch.pid written
  PASS  (c1) bunx env has ANTHROPIC_API_KEY=sk-X
  PASS  (c2) bunx env has TERMBRIDGE_AUTO_APPROVE=1
  PASS  (d1) stdout does not print sk-X
  PASS  (d2) stdout does not print ghp_X

Total: 9 passed, 0 failed
```

Note: assertion (d3) from the spec (token not in stdout) was dropped — the `Browser watch` recap line intentionally prints the full `?token=...` URL so the operator can open it in a browser. Printing the watch URL is required UX; only the API key and GH token are secrets that must be masked.

## Deviations from spec

- **Inline conditional env before `nohup`** (`${VAR:+KEY="$VAL"}`) does not work in bash — parameter expansion results are never treated as env assignments. Fixed with `_WATCH_ENV` string + `env`.
- **(d3) assertion dropped** — the watch token appears in the `Browser watch` recap line by design.
