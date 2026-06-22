#!/usr/bin/env bash
#
# termbridge one-shot setup for Hermes (or any MCP agent).
#
# Checks prereqs + versions, pulls the session sandbox image, logs you in to Claude
# once, registers the MCP server + engineer-loop skill in Hermes, and verifies — all
# idempotent (safe to re-run).
#
#   No clone needed:
#     curl -fsSL https://raw.githubusercontent.com/shivang2000/termbridge/main/scripts/setup.sh | bash
#   Or from a clone:
#     bash scripts/setup.sh
#
# Flags / env:
#   --mode docker|local     docker (default; chat-safe, isolated) | local (host tmux/gh, trusted machine)
#   --version X.Y.Z         pin a version (default: latest on npm, else 1.0.4)
#   --max-sessions N        concurrency cap (default 3)
#   --gh-token TOKEN        forward GH_TOKEN into sessions (in-container PRs); or set GH_TOKEN in env
#   --skip-login            don't run the one-time Claude login (assume creds already present)
#   --no-clone              don't clone the termbridge source (CLI/smokes) to ~/.termbridge/src
#   --restart               run `hermes gateway restart` at the end (⚠️ kills running agents)
#   -h | --help
set -euo pipefail

# ---- config / defaults -------------------------------------------------------
FALLBACK_VERSION="1.0.4"
MODE="docker"
VERSION=""
MAX_SESSIONS="3"
GH_TOKEN_ARG="${GH_TOKEN:-}"
SKIP_LOGIN="false"
NO_CLONE="false"
DO_RESTART="false"
TERMBRIDGE_HOME="${TERMBRIDGE_HOME:-$HOME/.termbridge/home}"
SRC_DIR="${TERMBRIDGE_SRC:-$HOME/.termbridge/src}"
REPO_URL="https://github.com/shivang2000/termbridge.git"
SKILL_URL="https://raw.githubusercontent.com/shivang2000/termbridge/main/skills/engineer-loop/SKILL.md"
SANDBOX_REPO="shivang2000/termbridge-sandbox"

# ---- pretty logging ----------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=; G=; Y=; R=; D=; N=; fi
step() { printf '%s\n' "${B}==>${N} $*"; }
ok()   { printf '%s\n' "  ${G}✓${N} $*"; }
warn() { printf '%s\n' "  ${Y}!${N} $*"; }
die()  { printf '%s\n' "  ${R}✗ $*${N}" >&2; exit 1; }

# ---- args --------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)         MODE="${2:-}"; shift 2 ;;
    --version)      VERSION="${2:-}"; shift 2 ;;
    --max-sessions) MAX_SESSIONS="${2:-}"; shift 2 ;;
    --gh-token)     GH_TOKEN_ARG="${2:-}"; shift 2 ;;
    --skip-login)   SKIP_LOGIN="true"; shift ;;
    --no-clone)     NO_CLONE="true"; shift ;;
    --restart)      DO_RESTART="true"; shift ;;
    -h|--help)      awk 'NR>1 && /^#/{sub(/^# ?/,"");print;next} NR>1{exit}' "$0"; exit 0 ;;
    *)              die "unknown flag: $1 (try --help)" ;;
  esac
done
case "$MODE" in docker|local) ;; *) die "--mode must be docker or local (got: $MODE)" ;; esac
[ "$MODE" = "docker" ] && ALLOWED_ENVS="docker" || ALLOWED_ENVS="local,docker"

# ---- 1. prereqs --------------------------------------------------------------
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker Desktop / engine first."
docker info >/dev/null 2>&1 || die "docker is installed but the daemon isn't running — start Docker."
ok "docker ready"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null && ok "node $(node -v) (npx available)" \
    || warn "node $(node -v 2>/dev/null) is < 20 — the MCP server runs via npx and wants node ≥ 20."
elif command -v bun >/dev/null 2>&1; then
  ok "bun $(bun -v) present (node not found — fine if your gateway runs the MCP via bun)"
else
  warn "neither node nor bun found — the gateway needs one to run \`npx -y @termbridge/mcp-server\`."
fi

HAS_HERMES="false"
if command -v hermes >/dev/null 2>&1; then HAS_HERMES="true"; ok "hermes CLI present"; else
  warn "hermes CLI not found — will set everything else up and print the manual MCP/skill steps."
fi

# GitHub auth (used to open PRs at the end of the loop): host gh and/or a forwarded token.
HOST_GH_AUTHED="false"
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then HOST_GH_AUTHED="true"; ok "host gh authenticated"; else
    warn "host gh present but not logged in — run \`gh auth login\` to let it open PRs."; fi
else
  warn "gh (GitHub CLI) not found on host — install + \`gh auth login\` for the host PR path."
fi

# ---- 2. resolve version ------------------------------------------------------
step "Resolving termbridge version"
if [ -z "$VERSION" ]; then
  if command -v npm >/dev/null 2>&1; then
    VERSION="$(npm view @termbridge/mcp-server version 2>/dev/null || true)"
  fi
  [ -z "$VERSION" ] && VERSION="$FALLBACK_VERSION" && warn "couldn't reach npm — using fallback $VERSION" \
    || ok "latest on npm: $VERSION"
else
  ok "pinned: $VERSION"
fi

# ---- 3. sandbox image --------------------------------------------------------
step "Pulling the session sandbox image"
IMAGE="$SANDBOX_REPO:$VERSION"
if ! docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
  warn "$IMAGE not found on the registry — falling back to :latest"
  IMAGE="$SANDBOX_REPO:latest"
fi
docker pull "$IMAGE" >/dev/null && ok "pulled $IMAGE"
docker tag "$IMAGE" termbridge:dev && ok "tagged as termbridge:dev (re-tag fixes any stale local termbridge:dev)"

# Smoke the image once (this RUNS the container) so we know a session will actually work.
SMOKE_OK="false"
if docker run --rm termbridge:dev sh -lc 'command -v claude && command -v gh && command -v git' >/dev/null 2>&1; then
  SMOKE_OK="true"; ok "image OK — claude + gh + git present (so in-container PRs work)"
else
  warn "image missing claude/gh/git — in-container PRs need gh; re-pull, or rely on host gh (local mode / fallback)."
fi

# ---- 4. one-time Claude login ------------------------------------------------
step "Claude login (creds shared by every session)"
mkdir -p "$TERMBRIDGE_HOME"
if [ -f "$TERMBRIDGE_HOME/.claude/.credentials.json" ]; then
  ok "already logged in ($TERMBRIDGE_HOME)"
elif [ "$SKIP_LOGIN" = "true" ]; then
  warn "no creds at $TERMBRIDGE_HOME but --skip-login set — sessions will need login first."
else
  # A terminal for the login TUI: stdin directly, or /dev/tty when piped (curl | bash).
  TTY_IN=""
  if [ -t 0 ]; then TTY_IN="-"; elif ( : >/dev/tty ) 2>/dev/null; then TTY_IN="/dev/tty"; fi
  if [ -n "$TTY_IN" ]; then
    warn "no creds yet — launching the login TUI (pick 'subscription', open URL, paste code, then exit)"
    if [ "$TTY_IN" = "/dev/tty" ]; then
      docker run --rm -it -v "$TERMBRIDGE_HOME:/creds" -e HOME=/creds termbridge:dev claude </dev/tty || true
    else
      docker run --rm -it -v "$TERMBRIDGE_HOME:/creds" -e HOME=/creds termbridge:dev claude || true
    fi
    [ -f "$TERMBRIDGE_HOME/.claude/.credentials.json" ] && ok "logged in" \
      || warn "login not detected — re-run, or: docker run --rm -it -v $TERMBRIDGE_HOME:/creds -e HOME=/creds termbridge:dev claude"
  else
    warn "no terminal available (fully non-interactive) — run login once manually:"
    printf '      %s\n' "docker run --rm -it -v $TERMBRIDGE_HOME:/creds -e HOME=/creds termbridge:dev claude"
  fi
fi

# ---- 4b. termbridge source (so users never clone by hand) --------------------
# Not needed for the chat flow (MCP runs via npx, skill via raw URL) — it's a
# convenience so the CLI (scripts/engineer.ts) + smokes are on hand.
CLONED_TO=""
if [ "$NO_CLONE" = "true" ]; then
  :
elif [ -f scripts/setup.sh ] && [ -f package.json ]; then
  ok "already inside a termbridge checkout — skipping source clone"
elif ! command -v git >/dev/null 2>&1; then
  warn "git not found — skipping source clone (not required for the chat flow)."
elif [ -d "$SRC_DIR/.git" ]; then
  ok "termbridge source already at $SRC_DIR"; CLONED_TO="$SRC_DIR"
else
  step "Cloning termbridge source → $SRC_DIR (CLI + smokes)"
  if git clone --depth 1 "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1; then
    ok "cloned to $SRC_DIR"; CLONED_TO="$SRC_DIR"
  else
    warn "clone failed — not required for the chat flow; the MCP still runs from npx."
  fi
fi

# ---- 5. register MCP + skill in Hermes ---------------------------------------
ENV_PAIRS=( "TERMBRIDGE_HOME=$TERMBRIDGE_HOME" "TERMBRIDGE_TMUX_SOCKET=termbridge" \
            "TERMBRIDGE_ALLOWED_ENVS=$ALLOWED_ENVS" "TERMBRIDGE_MAX_SESSIONS=$MAX_SESSIONS" )
[ -n "$GH_TOKEN_ARG" ] && ENV_PAIRS+=( "GH_TOKEN=$GH_TOKEN_ARG" )

if [ "$HAS_HERMES" = "true" ]; then
  step "Registering termbridge in Hermes (mode: $MODE)"
  if hermes mcp list 2>/dev/null | grep -qw termbridge; then
    warn "termbridge already registered — leaving it. To change env, edit ~/.hermes/config.yaml or re-add."
  else
    hermes mcp add termbridge --env "${ENV_PAIRS[@]}" --command npx --args -y @termbridge/mcp-server \
      && ok "MCP server registered" || warn "hermes mcp add failed — add it manually (see config block below)."
  fi
  step "Installing the engineer-loop skill"
  hermes skills install "$SKILL_URL" --yes >/dev/null 2>&1 && ok "skill installed" \
    || warn "skill install failed — run: hermes skills install $SKILL_URL --yes"
  step "Verifying the MCP connection"
  hermes mcp test termbridge || warn "mcp test reported an issue — check creds + that npx can resolve the package."
else
  step "Manual Hermes steps (CLI not found)"
  printf '  Once hermes is installed, run:\n'
  printf '    hermes mcp add termbridge \\\n'
  for kv in "${ENV_PAIRS[@]}"; do
    case "$kv" in GH_TOKEN=*) printf '      --env %s \\\n' "GH_TOKEN=***" ;; \
                  *)          printf '      --env %s \\\n' "$kv" ;; esac
  done
  printf '      --command npx --args -y @termbridge/mcp-server\n'
  printf '    hermes skills install %s --yes\n' "$SKILL_URL"
fi

# ---- 6. gateway restart (gated — the user does this, but we make it loud) -----
RESTART_PENDING="false"
if [ "$HAS_HERMES" = "true" ]; then
  step "Apply"
  if [ "$DO_RESTART" = "true" ]; then
    warn "restarting the gateway (kills running agents)…"; hermes gateway restart && ok "gateway restarted"
  else
    RESTART_PENDING="true"   # surfaced loudly in the recap below
  fi
fi

# ---- 7. authentication summary — what the user still needs -------------------
authline() { printf '  %-24s %s\n' "$1" "$2"; }
step "Authentication — what you need"
# Claude subscription (this is what the whole thing bills against).
if [ -f "$TERMBRIDGE_HOME/.claude/.credentials.json" ]; then
  authline "Claude (subscription)" "${G}✓ logged in${N}  — required; every session reuses these creds"
else
  authline "Claude (subscription)" "${R}✗ REQUIRED${N} → docker run --rm -it -v $TERMBRIDGE_HOME:/creds -e HOME=/creds termbridge:dev claude"
fi
# GitHub — to open the PR at the end of the loop. Need depends on mode.
if [ "$MODE" = "local" ]; then
  if [ "$HOST_GH_AUTHED" = "true" ]; then
    authline "GitHub (open PRs)" "${G}✓ host gh authed${N}  — local mode pushes + opens PRs with it"
  else
    authline "GitHub (open PRs)" "${R}✗ run: gh auth login${N}  — local mode opens the PR via your host gh"
  fi
else
  if [ -n "$GH_TOKEN_ARG" ]; then
    authline "GitHub (open PRs)" "${G}✓ GH_TOKEN forwarded${N}  — the container opens the PR itself"
  elif [ "$HOST_GH_AUTHED" = "true" ]; then
    authline "GitHub (open PRs)" "${G}✓ host gh authed${N}  — host fallback opens the PR (no token needed)"
  else
    authline "GitHub (open PRs)" "${Y}! needed for PRs${N} → re-run with --gh-token ghp_xxx (in-container) OR gh auth login (host)"
  fi
fi
# Jira / tracker — Hermes' job, not termbridge's. Informational.
authline "Jira / tracker" "${D}optional — authenticate your tracker tool IN HERMES so it can fetch tickets; else paste the ticket text${N}"
printf '  %s\n' "${D}(termbridge never logs in to GitHub/Jira itself — it pilots Claude; the host/agent handle those.)${N}"

# ---- 8. recap — what setup did, and what's left for you ----------------------
printf '\n%s\n' "${B}── Recap ──────────────────────────────────────────────${N}"
printf '%s\n' "Done by setup:"
authline "  Docker image" "termbridge:dev ready ($([ "$SMOKE_OK" = "true" ] && printf 'claude+gh+git ✓' || printf 'see warning above'))"
authline "  Session container" "${D}launched per-session by termbridge at run time — not started now${N}"
[ -n "$CLONED_TO" ] && authline "  Source (CLI/smokes)" "${D}$CLONED_TO${N}"
if [ "$HAS_HERMES" = "true" ]; then
  authline "  Hermes MCP" "registered + verified via \`hermes mcp test\` (result above)"
  authline "  Skills" "engineer-loop installed — the only required skill"
else
  authline "  Hermes" "${Y}CLI not found${N} — MCP + skill steps printed above for you to run"
fi

printf '\n%s\n' "Your turn:"
[ -f "$TERMBRIDGE_HOME/.claude/.credentials.json" ] || \
  printf '  %s\n' "${R}• Log in to Claude${N} (command in the Authentication section above) — required"
if [ "$RESTART_PENDING" = "true" ]; then
  printf '  %s\n' "${Y}${B}• ACTION REQUIRED:${N}${Y} restart the gateway to load the MCP server + skill —${N}"
  printf '  %s\n' "${Y}    it ${B}kills running agents${N}${Y}, so run it when idle:${N}"
  printf '      %s\n' "hermes gateway restart"
fi
printf '  %s\n' "• Clone the target repo locally (where the session can reach it)"

printf '\n%s\n' "${G}${B}termbridge ready.${N}  mode=$MODE · version=$VERSION · max_sessions=$MAX_SESSIONS"
printf '%s\n' "Then DM the bot, e.g.:"
printf '  %s\n' "${B}@bot use the engineer-loop skill (env: $MODE): ship PROJ-123 in <repo>, verify with <cmd>, open a PR${N}"
