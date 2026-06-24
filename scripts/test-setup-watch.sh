#!/usr/bin/env bash
# Stub test for `scripts/setup.sh --watch`
# Asserts:
#   (a) hermes mcp add env contains TERMBRIDGE_SERVER_URL + TERMBRIDGE_TOKEN
#       and does NOT contain ANTHROPIC_API_KEY / GH_TOKEN
#   (b) $HOME/.termbridge/watch.pid was written
#   (c) bunx server invocation env carried ANTHROPIC_API_KEY + TERMBRIDGE_AUTO_APPROVE
#   (d) script STDOUT never prints the literal sk-X / ghp_X (the watch URL token is
#       intentional output for the user and is allowed to appear)
set -euo pipefail

PASS=0; FAIL=0
assert() {
  local label="$1" result="$2"
  if [ "$result" = "true" ]; then
    printf '  PASS  %s\n' "$label"; PASS=$((PASS+1))
  else
    printf '  FAIL  %s\n' "$label"; FAIL=$((FAIL+1))
  fi
}

# ---- temp environment -------------------------------------------------------
TMPDIR_TEST="$(mktemp -d)"
FAKE_HOME="$TMPDIR_TEST/home"
mkdir -p "$FAKE_HOME/.claude"
# fake credentials.json so the auth check passes without prompting
echo '{"token":"fake"}' > "$FAKE_HOME/.claude/.credentials.json"

FAKE_BIN="$TMPDIR_TEST/bin"
mkdir -p "$FAKE_BIN"

HERMES_CALLS="$TMPDIR_TEST/hermes_calls.txt"
BUNX_ENV="$TMPDIR_TEST/bunx_env.txt"
touch "$HERMES_CALLS" "$BUNX_ENV"

# ---- stubs ------------------------------------------------------------------

# claude stub
cat >"$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude 1.0.0"
EOF

# node stub — forward to real node (port-finder + version check)
REAL_NODE="$(command -v node)"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$REAL_NODE" > "$FAKE_BIN/node"

# npm stub
cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo "1.0.4"
EOF

# gh stub — auth status OK, token returns empty
cat >"$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
  status) exit 0 ;;
  token)  echo ""; exit 0 ;;
esac
EOF

# bun stub
cat >"$FAKE_BIN/bun" <<'EOF'
#!/usr/bin/env bash
echo "1.2.0"
EOF

# bunx stub — called via `nohup env KEY=VAL ... bunx @termbridge/server`.
# Use printf (not heredoc) to avoid shell interpolation of ${VAR} at creation time.
# The PATH expansion (${ANTHROPIC_API_KEY:-UNSET}) must be left for runtime.
printf '#!/usr/bin/env bash\n' > "$FAKE_BIN/bunx"
printf '{\n' >> "$FAKE_BIN/bunx"
printf '  echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-UNSET}"\n' >> "$FAKE_BIN/bunx"
printf '  echo "TERMBRIDGE_AUTO_APPROVE=${TERMBRIDGE_AUTO_APPROVE:-UNSET}"\n' >> "$FAKE_BIN/bunx"
printf '  echo "GH_TOKEN=${GH_TOKEN:-UNSET}"\n' >> "$FAKE_BIN/bunx"
printf '} >> "%s"\n' "$BUNX_ENV" >> "$FAKE_BIN/bunx"
printf '# linger so PID is valid when read\nsleep 2 &\nexit 0\n' >> "$FAKE_BIN/bunx"

# hermes stub — record args; support the verbs setup.sh calls
printf '#!/usr/bin/env bash\n' > "$FAKE_BIN/hermes"
printf 'echo "$@" >> "%s"\n' "$HERMES_CALLS" >> "$FAKE_BIN/hermes"
cat >>"$FAKE_BIN/hermes" <<'EOF'
case "${1:-} ${2:-}" in
  "mcp list")       echo "no servers registered"; exit 0 ;;
  "mcp --help")     echo "Usage: hermes mcp [remove|add|list|test]"; exit 0 ;;
  "mcp add")        echo "termbridge added"; exit 0 ;;
  "mcp test")       echo "OK"; exit 0 ;;
  "skills install") exit 0 ;;
  "gateway restart") exit 0 ;;
esac
exit 0
EOF

chmod +x "$FAKE_BIN"/*

# ---- run setup.sh -----------------------------------------------------------
STDOUT_FILE="$TMPDIR_TEST/stdout.txt"
export HOME="$FAKE_HOME"

PATH="$FAKE_BIN:$PATH" bash /Users/shivang/dev/termbridge/scripts/setup.sh \
  --mode local \
  --watch \
  --api-key sk-X \
  --gh-token ghp_X \
  >"$STDOUT_FILE" 2>&1 || true

# Give the background bunx stub a moment to write
sleep 0.5

# ---- assertions -------------------------------------------------------------
printf '\nAssertion results:\n'

# (a) hermes mcp add args must contain TERMBRIDGE_SERVER_URL and TERMBRIDGE_TOKEN
#     but NOT ANTHROPIC_API_KEY or GH_TOKEN
MCP_ADD_LINE="$(grep "^mcp add " "$HERMES_CALLS" | head -1 || true)"

assert "(a1) mcp add contains TERMBRIDGE_SERVER_URL" \
  "$(echo "$MCP_ADD_LINE" | grep -q "TERMBRIDGE_SERVER_URL=" && echo true || echo false)"

assert "(a2) mcp add contains TERMBRIDGE_TOKEN" \
  "$(echo "$MCP_ADD_LINE" | grep -q "TERMBRIDGE_TOKEN=" && echo true || echo false)"

assert "(a3) mcp add does NOT contain ANTHROPIC_API_KEY" \
  "$(echo "$MCP_ADD_LINE" | grep -qv "ANTHROPIC_API_KEY" && echo true || echo false)"

assert "(a4) mcp add does NOT contain GH_TOKEN" \
  "$(echo "$MCP_ADD_LINE" | grep -qv "GH_TOKEN=" && echo true || echo false)"

# (b) watch.pid was written
assert "(b)  watch.pid written" \
  "$([ -f "$FAKE_HOME/.termbridge/watch.pid" ] && echo true || echo false)"

# (c) bunx server invocation carried ANTHROPIC_API_KEY and TERMBRIDGE_AUTO_APPROVE
assert "(c1) bunx env has ANTHROPIC_API_KEY=sk-X" \
  "$(grep -q "ANTHROPIC_API_KEY=sk-X" "$BUNX_ENV" && echo true || echo false)"

assert "(c2) bunx env has TERMBRIDGE_AUTO_APPROVE=1" \
  "$(grep -q "TERMBRIDGE_AUTO_APPROVE=1" "$BUNX_ENV" && echo true || echo false)"

# (d) stdout does not contain literal API key or GH token values.
#     The watch URL (with session token) IS allowed — it's the user-facing access link.
assert "(d1) stdout does not print sk-X" \
  "$(grep -qF "sk-X" "$STDOUT_FILE" && echo false || echo true)"

assert "(d2) stdout does not print ghp_X" \
  "$(grep -qF "ghp_X" "$STDOUT_FILE" && echo false || echo true)"

# ---- cleanup ----------------------------------------------------------------
WPID="$(cat "$FAKE_HOME/.termbridge/watch.pid" 2>/dev/null || true)"
[ -n "$WPID" ] && kill "$WPID" 2>/dev/null || true
rm -rf "$TMPDIR_TEST"

# ---- summary ----------------------------------------------------------------
printf '\nTotal: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
