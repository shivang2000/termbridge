import type { RecognizedEvent, Recognizer } from "../types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC ] and end with BEL or ST
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
	return s.replace(OSC, "").replace(ANSI, "");
}

/**
 * `tb-marker` recognizers — surface the marker protocol that the
 * `engineer-loop` skill instructs the driven claude to print.
 *
 * Markers are the contract between a driven CLI and the loop driving it:
 * line-based, anchored (must be the first token on the line, after
 * optional indentation + a single TUI bullet), echo-safe (the prompt's
 * instruction text must NOT match), and visible across the noisy TUI.
 *
 * Each recognizer is a separate `Recognizer` so its emitted kind at the
 * top of the event (what `wait_for_event({ kinds: [...] })` filters on) IS
 * the actionable type:
 *
 *   needs_user_input             ← TB_ASK: <question>
 *   self_check_request           ← TB_SELF_CHECK: <cmd>
 *
 * The completion markers (`TB_LOOP_DONE`, `TB_PR_URL`, `TB_BRANCH_READY`)
 * are matched inline by `engineer-loop.ts` over the raw screen — they are
 * loop-control, not state to surface as a recognizer event.
 */

// The marker must be the FIRST token on its line (after optional indentation
// and a single TUI bullet like ●/⏺/>/-). Mirrors engineer-loop.ts.
const LINE_LEAD = String.raw`^[ \t]*(?:[●⏺▸>*\-]\s+)?`;
const ASK_RE = new RegExp(`${LINE_LEAD}TB_ASK:[ \\t]*(.+?)[ \\t]*$`, "im");
const SELF_CHECK_RE = new RegExp(`${LINE_LEAD}TB_SELF_CHECK:[ \\t]*(.+?)[ \\t]*$`, "im");

/**
 * Iterate `re` against `text` and return the LAST capture group 1.
 *
 * The regex isn't built with /g on purpose: the LINE_LEAD leading-anchor
 * (`^[ \t]*(?:[●⏺▸>*\-]\s+)?`) plus the `im` anchors make stateful
 * matching fragile on a shared instance. We rebuild `re` from source +
 * flags once (cheap — V8 caches the compiled program by (source,flags)
 * after the first build of a given literal pair, so this is an O(1)
 * lookup after the first call). Then we re-exec against the SUBSTRING
 * past the previous match start, advancing the cursor in the ORIGINAL
 * text's coordinates.
 *
 * Why "last" and not "first": Claude can ask a second question before
 * the first clears the visible pane, and downstream consumers must hand
 * the operator the NEWEST visible marker.
 */
function lastCaptureGroup1(re: RegExp, text: string): string | undefined {
	// One rebuild per call. Reuse the compiled program via the source +
	// flags; V8 keeps a small cache by (source, flags) and the regexes
	// here are module-singletons, so this is a hash-map hit in practice.
	const r = new RegExp(re.source, re.flags);
	let cursor = 0;
	let last: string | undefined;
	while (cursor <= text.length) {
		const rest = text.slice(cursor);
		const m = r.exec(rest);
		if (!m || m[1] === undefined) break;
		last = m[1];
		// Advance cursor past the match start (in the ORIGINAL text's coords).
		cursor += m.index + Math.max(1, m[0].length);
	}
	return last;
}

export const needsUserInputMarkerRecognizer: Recognizer = {
	kind: "needs_user_input",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		// capture-pane can return blank when bytes streamed but the visible
		// pane hasn't repainted yet — fall back to the recent bytes buffer.
		const raw = screen.trim() ? screen : recentBytes;
		const question = lastCaptureGroup1(ASK_RE, stripAnsi(raw));
		if (question === undefined) return null;
		return {
			data: { question },
			// No suggested key — the relay has to WAIT for a human reply.
			suggestedKeys: [],
		};
	},
};

export const selfCheckMarkerRecognizer: Recognizer = {
	kind: "self_check_request",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		const raw = screen.trim() ? screen : recentBytes;
		const command = lastCaptureGroup1(SELF_CHECK_RE, stripAnsi(raw));
		if (command === undefined) return null;
		return {
			data: { command },
			suggestedKeys: [],
		};
	},
};
