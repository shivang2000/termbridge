# Recognizer screen fixtures (P2.1)

Regression corpus for version-fragile TUI recognizers. The guard suite
(`corpus.guard.test.ts`) asserts every `*.txt` here still matches its recognizer.

## Re-capture

When Claude Code (or another piloted TUI) changes and a recognizer breaks:

1. Open a real session: `tmux -L termbridge new-session -s capture …`
2. Drive to the prompt you care about.
3. Capture: `tmux -L termbridge capture-pane -t capture -p` (add `-e` if you
   want ANSI; most recognizers strip SGR themselves).
4. Save under the matching directory:
   `{scenario}-{claude-version}.txt` (e.g. `tool-create-2.1.200.txt`).
5. Re-tune **only** the recognizer module for that kind.
6. Run: `bun test packages/core/src/recognizers/corpus.guard.test.ts`

## Layout

| Directory | Recognizer | Event `kind` |
|---|---|---|
| `claude-permission/` | `claudePermissionRecognizer` | `claude-permission` |
| `claude-activity/` | `claudeActivityRecognizer` | `claude-activity` |
| `oauth-url/` | `oauthUrlRecognizer` | `oauth-url` |
| `rate-limit/` | `rateLimitRecognizer` | `rate_limited` |
| `generic-yn/` | `genericYnRecognizer` | `generic-yn` |
| `tb-marker-ask/` | `needsUserInputMarkerRecognizer` | `needs_user_input` |
| `tb-marker-self-check/` | `selfCheckMarkerRecognizer` | `self_check_request` |

## Rules

- Positive matches only (screens that **must** fire). Negatives stay in unit /
  adversary tests.
- No secrets or real OAuth tokens — use dummy URLs/codes.
- Prefer verbatim live captures when available (see `*-2.1.183.txt`).
