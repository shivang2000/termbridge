import type { RecognizedEvent, Recognizer } from "../types.js";

/**
 * `rate-limit` recognizer (D7). Detects the Claude Code usage/rate-limit screens
 * that appear when the logged-in subscription has hit its plan limits — the
 * exact failure mode the fleet caveat in CLAUDE.md warns about. An orchestrator
 * uses this event to back off / cap concurrency rather than keep hammering a
 * throttled plan.
 *
 * Examples it catches: "usage limit reached", "rate limit", "you're out of
 * usage/messages", "limit will reset at …", "too many requests", "upgrade to
 * increase your usage".
 *
 * WARNING — VERSION FRAGILE BY DESIGN. The patterns below track the wording of
 * the live Claude TUI's usage/rate-limit screens. That copy changes between
 * releases, so these regexes WILL drift. All matching is deliberately isolated
 * in this single module: when the live TUI changes, re-capture a real screen and
 * re-tune the patterns HERE ONLY. The tests use captured fixtures, not the live
 * binary, so there is no automated guard against TUI drift.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC + DCS sequences also start with ESC
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** Strip ANSI/OSC control sequences so plain-text patterns can match. */
function stripAnsi(s: string): string {
	return s.replace(OSC, "").replace(ANSI, "");
}

// --- patterns --------------------------------------------------------------

/**
 * Individual signals that indicate a usage/rate-limit screen, in priority order.
 *
 * The `rate limit` signal is deliberately NOT the bare phrase: in normal coding
 * output the words "rate limit" / "rate limiting" appear constantly (config
 * keys, middleware, nginx, prose) and a false `rate_limited` event would make an
 * orchestrator needlessly back off a perfectly healthy session — the opposite of
 * what this recognizer is for. The genuine TUI screen pairs the phrase with a
 * failure verb ("hit a rate limit", "rate limit reached/exceeded", "you have
 * been rate limited"), so we require that context and reject the "rate limiting"
 * gerund.
 */
const SIGNALS: RegExp[] = [
	/usage limit reached/i,
	// "hit a rate limit", "reached the rate limit", "you have been rate limited"
	/(?:hit|reached|exceeded|been)\s+(?:a\s+|the\s+|your\s+)?rate[- ]limit(?:ed)?/i,
	// "rate limit reached/exceeded" (phrase first, failure verb after)
	/rate[- ]limit\s+(?:has\s+been\s+|is\s+)?(?:reached|exceeded)/i,
	/you'?re out of (?:usage|messages)/i,
	/limit will reset/i,
	/too many requests/i,
	/upgrade to increase your usage/i,
];

/**
 * Capture the reset window, e.g. "resets at 3:00 PM" / "reset in 2 hours".
 *
 * The `at`/`in` joiner is REQUIRED: without it the pattern matched a bare
 * "reset" anywhere on screen and happily attached garbage to a real event —
 * "git reset --hard HEAD" yielded `resetsAt: "--hard HEAD"`, "git reset to fix
 * things" yielded `resetsAt: "to fix things"`. An orchestrator parsing
 * `resetsAt` to schedule its back-off would be misled, so we only capture a
 * window introduced by an explicit "at"/"in".
 */
const RESETS_AT = /reset(?:s)?\s+(?:at|in)\s+([^\n.]+)/i;

export const rateLimitRecognizer: Recognizer = {
	kind: "rate_limited",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		// `tmux capture-pane` frequently returns a blank- or whitespace-padded
		// screen even while real output streamed through the byte tail, so treat a
		// screen with no visible glyphs as "empty" and fall back to `recentBytes`.
		const fromScreen = stripAnsi(screen);
		const text = fromScreen.trim() ? fromScreen : stripAnsi(recentBytes);
		const lines = text.split("\n");

		// Find the first signal that matches anywhere in the text.
		let matched: RegExpExecArray | null = null;
		for (const pattern of SIGNALS) {
			const m = pattern.exec(text);
			if (m) {
				matched = m;
				break;
			}
		}
		if (!matched) {
			return null;
		}

		// The message is the most-relevant line: the trimmed line containing the
		// matched signal, falling back to the matched substring itself.
		const matchedText = matched[0];
		const message = lines.map((l) => l.trim()).find((l) => l.includes(matchedText)) ?? matchedText;

		const reset = RESETS_AT.exec(text);
		const resetsAt = reset?.[1]?.trim();

		return {
			data: { message, ...(resetsAt ? { resetsAt } : {}) },
			suggestedKeys: [],
		};
	},
};
