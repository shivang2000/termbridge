import type { RecognizedEvent, Recognizer } from "../types.js";

/**
 * `claude-permission` recognizer (D7). Detects the interactive prompts that the
 * Claude Code TUI raises while it works:
 *
 *   1. TOOL PERMISSION  — a numbered "Do you want to …?" choice (proceed / make
 *      this edit / create …) where option 1 is "Yes".
 *   2. BYPASS PERMISSIONS — the dangerous "Bypass Permissions mode" gate with an
 *      "I accept" option.
 *   3. PASTE CODE — the login flow's "Paste code here if prompted" prompt.
 *
 * WARNING — VERSION FRAGILE BY DESIGN. Every pattern below is tuned against the
 * Claude Code 2.1.x TUI. The TUI's exact wording, option ordering, marker glyph
 * (❯) and layout change between releases, so these regexes WILL drift. All
 * matching is deliberately isolated in this single module: when the live TUI
 * changes, re-capture a real screen and re-tune the patterns HERE ONLY — no
 * other unit should encode Claude-prompt shapes. There is no automated guard
 * against TUI drift; the tests use captured fixtures, not the live binary.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC + DCS sequences also start with ESC
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** Strip ANSI/OSC control sequences so plain-text patterns can match. */
function stripAnsi(s: string): string {
	return s.replace(OSC, "").replace(ANSI, "");
}

// --- patterns (2.1.x) ------------------------------------------------------

/** "Do you want to proceed?" / "… make this edit?" / "… create …?" etc. */
const QUESTION = /^\s*(Do you want to[^\n]*\?)\s*$/im;

/** A numbered option line, optionally prefixed by the ❯ selection marker. */
const OPTION = /^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/;

/** "Bypass Permissions" / "bypass permissions mode" anywhere on screen. */
const BYPASS = /bypass permissions/i;

/** The accept option inside the bypass gate, e.g. "2. Yes, I accept". */
const BYPASS_ACCEPT = /^\s*[❯>]?\s*(\d+)\.\s+(?:Yes,?\s*)?I accept\b/im;

/** Login paste prompt. */
const PASTE = /paste\s+(?:the\s+)?code\b|paste\s+code\s+here/i;

interface NumberedOption {
	num: string;
	label: string;
}

/** Pull every "N. label" option line out of the stripped screen, in order. */
function parseOptions(lines: string[]): NumberedOption[] {
	const out: NumberedOption[] = [];
	for (const line of lines) {
		const m = OPTION.exec(line);
		if (m?.[1] && m[2] !== undefined) {
			out.push({ num: m[1], label: m[2] });
		}
	}
	return out;
}

export const claudePermissionRecognizer: Recognizer = {
	kind: "claude-permission",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		// `tmux capture-pane` frequently returns a blank- or whitespace-padded
		// screen even while real prompt output streamed through the byte tail, so
		// treat a screen with no visible glyphs as "empty" and fall back to
		// `recentBytes` — not just the strict empty-string case.
		const fromScreen = stripAnsi(screen);
		const text = fromScreen.trim() ? fromScreen : stripAnsi(recentBytes);
		const lines = text.split("\n");

		// 1. TOOL PERMISSION — highest priority.
		const q = QUESTION.exec(text);
		if (q?.[1]) {
			const options = parseOptions(lines).map((o) => o.label);
			return {
				data: { kind: "tool", question: q[1], options },
				suggestedKeys: ["1"],
			};
		}

		// 2. BYPASS PERMISSIONS accept.
		if (BYPASS.test(text)) {
			const accept = BYPASS_ACCEPT.exec(text);
			const num = accept?.[1] ?? "2";
			const question =
				lines.map((l) => l.trim()).find((l) => BYPASS.test(l)) ?? "Bypass Permissions";
			return {
				data: { kind: "bypass", question },
				suggestedKeys: [num],
			};
		}

		// 3. PASTE CODE.
		const paste = PASTE.exec(text);
		if (paste) {
			const question = lines.map((l) => l.trim()).find((l) => PASTE.test(l)) ?? "Paste code";
			return {
				data: { kind: "paste", question },
				suggestedKeys: [],
			};
		}

		return null;
	},
};
