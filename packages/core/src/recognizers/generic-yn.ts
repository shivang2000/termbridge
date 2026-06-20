import type { RecognizedEvent, Recognizer } from "../types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC ] and end with BEL or ST
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: DCS (ESC P), SOS/PM/APC sequences end with ST (ESC \)
const STRING_SEQ = /\x1b[P^_][\s\S]*?\x1b\\/g;

/**
 * Apply bare carriage-return overwrites within a single line. Terminals use a
 * lone `\r` (not followed by `\n`) to return the cursor to column 0 and redraw
 * over the existing text — progress bars and re-rendered prompts do this. We
 * model it as a column-wise overlay: each `\r`-delimited segment is written
 * starting at column 0 over the accumulating buffer, so a partial redraw keeps
 * the un-overwritten tail and a trailing `\r` (nothing after it) leaves the
 * visible line intact. Without this, stale pre-`\r` text and the control byte
 * itself leak into the recognised prompt.
 */
function applyCarriageReturns(line: string): string {
	if (line.indexOf("\r") === -1) return line;
	const segments = line.split("\r");
	let buf = "";
	for (const seg of segments) {
		buf = seg + buf.slice(seg.length);
	}
	return buf;
}

/**
 * Trailing yes/no markers we recognise. Bracketed shorthand carries an optional
 * default via capitalisation ([y/N] -> default n, [Y/n] -> default y); the long
 * (yes/no) form has no default convention. Each captures the two option tokens
 * so the default can be derived from which one is upper-cased.
 */
const YN_MARKERS = [
	// [y/N] / [Y/n] / [y/n]
	/\[([yY])\/([nN])\]/,
	// (y/N) / (Y/n) / (y/n)
	/\(([yY])\/([nN])\)/,
	// (yes/no) — long form, no default convention
	/\((yes)\/(no)\)/i,
];

/**
 * Derive the default answer from the option capitalisation. Convention: the
 * upper-cased option is the default ([y/N] -> "n", [Y/n] -> "y"). When neither
 * is upper-cased (e.g. [y/n] or the long (yes/no) form), there is no default.
 */
function defaultFromOptions(yes: string, no: string): "y" | "n" | null {
	if (yes === "Y") return "y";
	if (no === "N") return "n";
	return null;
}

/**
 * `generic-yn` recognizer (D7). Detects a trailing yes/no confirmation prompt
 * near the END of the screen — the catch-all for the many CLIs that print
 * `[y/N]`, `(y/n)`, `(yes/no)`, etc. The default is read from the option
 * capitalisation; `suggestedKeys` proposes that default (falling back to "y"
 * when none is marked) so an agent has a safe single keypress to send.
 *
 * ANSI escapes are stripped before matching (like the url-detector) so colour
 * codes wrapping the marker don't defeat detection. Returns null when no y/n
 * marker is present.
 */
export const genericYnRecognizer: Recognizer = {
	kind: "generic-yn",
	match(screen: string, _recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		const clean = screen.replace(STRING_SEQ, "").replace(OSC, "").replace(ANSI, "");

		// Walk lines bottom-up: the prompt we care about is the last non-empty
		// line carrying a y/n marker. Each line is collapsed for bare `\r`
		// overwrites before trimming so terminal re-draws don't leak.
		const lines = clean.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = applyCarriageReturns(lines[i] ?? "").trim();
			if (line.length === 0) continue;

			for (const marker of YN_MARKERS) {
				const m = line.match(marker);
				if (!m) continue;
				const yes = m[1] ?? "";
				const no = m[2] ?? "";
				const def = marker === YN_MARKERS[2] ? null : defaultFromOptions(yes, no);
				return {
					data: { prompt: line, default: def },
					suggestedKeys: [def ?? "y"],
				};
			}
		}

		return null;
	},
};
