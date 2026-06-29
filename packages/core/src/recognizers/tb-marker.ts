import type { RecognizedEvent, Recognizer } from "../types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC ] and end with BEL or ST
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
	return s.replace(OSC, "").replace(ANSI, "");
}

/**
 * `tb-marker` recognizer — surfaces the marker protocol that the
 * `engineer-loop` skill instructs the driven claude to print.
 *
 * Markers are the contract between a driven CLI and the loop driving it:
 * line-based, anchored (must be the first token on the line, after
 * optional indentation + a single TUI bullet), echo-safe (the prompt's
 * instruction text must NOT match), and visible across the noisy TUI.
 *
 * Currently recognized:
 *   TB_ASK: <question>      →  needs_user_input event (question = text)
 *   TB_SELF_CHECK: <cmd>    →  self_check event  (cmd = text)
 *
 * The completion markers (`TB_LOOP_DONE`, `TB_PR_URL`, `TB_BRANCH_READY`)
 * are matched inline by `engineer-loop.ts` over the raw screen — they are
 * loop-control, not state to surface as a recognizer event.
 */

// The marker must be the FIRST token on its line (after optional indentation
// and a single TUI bullet like ●/⏺/>/-). Mirrors engineer-loop.ts.
const LINE_LEAD = String.raw`^[ \t]*(?:[●⏺▸>*\-]\s+)?`;
const ASK = new RegExp(`${LINE_LEAD}TB_ASK:[ \\t]*(.+?)[ \\t]*$`, "im");
const SELF_CHECK = new RegExp(`${LINE_LEAD}TB_SELF_CHECK:[ \\t]*(.+?)[ \\t]*$`, "im");

export const tbMarkerRecognizer: Recognizer = {
	kind: "tb-marker",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		// capture-pane can return blank when bytes streamed but the visible
		// pane hasn't repainted yet — fall back to the recent bytes buffer.
		const raw = screen.trim() ? screen : recentBytes;
		const clean = stripAnsi(raw);

		const ask = ASK.exec(clean);
		if (ask?.[1]) {
			return {
				data: { kind: "needs_user_input", question: ask[1] },
				// No suggested key — the relay has to WAIT for a human reply.
				suggestedKeys: [],
			};
		}

		const sc = SELF_CHECK.exec(clean);
		if (sc?.[1]) {
			return {
				data: { kind: "self_check", command: sc[1] },
				suggestedKeys: [],
			};
		}

		return null;
	},
};
