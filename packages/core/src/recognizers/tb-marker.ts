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

export const needsUserInputMarkerRecognizer: Recognizer = {
	kind: "needs_user_input",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		// capture-pane can return blank when bytes streamed but the visible
		// pane hasn't repainted yet — fall back to the recent bytes buffer.
		const raw = screen.trim() ? screen : recentBytes;
		const ask = ASK_RE.exec(stripAnsi(raw));
		if (!ask?.[1]) return null;
		return {
			data: { question: ask[1] },
			// No suggested key — the relay has to WAIT for a human reply.
			suggestedKeys: [],
		};
	},
};

export const selfCheckMarkerRecognizer: Recognizer = {
	kind: "self_check_request",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		const raw = screen.trim() ? screen : recentBytes;
		const sc = SELF_CHECK_RE.exec(stripAnsi(raw));
		if (!sc?.[1]) return null;
		return {
			data: { command: sc[1] },
			suggestedKeys: [],
		};
	},
};
