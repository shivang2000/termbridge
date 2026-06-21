import type { RecognizedEvent, Recognizer } from "../types.js";

/**
 * `claude-activity` recognizer (M7). Reports the COARSE lifecycle phase of a
 * Claude Code TUI session by inspecting the TAIL of the visible pane, so an
 * orchestrator can tell "still working" from "waiting on me" from "done"
 * without parsing the full transcript.
 *
 * It emits exactly one `phase`:
 *   tool           — a tool is actively running ("● Update(package.json)")
 *   editing        — a diff/edit block is on screen (+/- lines under a tool)
 *   thinking       — the reasoning spinner is up (any verb + "esc to interrupt")
 *   awaiting_input — a numbered selection prompt is blocking on a human
 *   idle           — the empty input box is present and no work is active
 *   (responding is reserved and folded into idle)
 *
 * KEY ROBUSTNESS RULES (hardened after an adversarial review):
 *  - "Active work" is gated on a spinner — and the spinner is detected by the
 *    VERSION-STABLE substring "esc to interrupt" (Claude rotates the glyph and
 *    the verb — Cogitating/Puzzling/Pondering/… — but always shows
 *    "esc to interrupt" while busy). A bare "✻" glyph alone is NOT a spinner.
 *  - A finished tool bullet left on screen above the empty input box is IDLE,
 *    not "tool" — otherwise the phase never settles after the first tool of a
 *    turn. So when the input box is present and NO spinner is up, we report idle
 *    even if a completed "● Tool(...)" / diff bullet is still in the tail.
 *  - awaiting_input keys on the actual "❯ N." selection cursor (not a plain
 *    markdown "> 1." blockquote), so it catches ANY approval (edit / bash / MCP
 *    / trust) without a brittle header-wording allow-list, and ordinary docs do
 *    not trip it.
 *  - Tool lines tolerate a leading/trailing box-border bar and MCP/underscore
 *    names ("● mcp__server__tool(args)"); `file` is only set for file-ish tools.
 *  - idle requires the rounded input FRAME (╭─ … ╰─) + an empty "❯", so a vim/
 *    lazygit/table "│ ❯ text" status line is NOT mistaken for "done".
 *
 * Returns null when nothing recognizable is present so the pipeline stays quiet.
 *
 * WARNING — VERSION FRAGILE BY DESIGN, exactly like claude-permission.ts: every
 * pattern is tuned against the Claude Code 2.1.x TUI and WILL drift. Re-capture
 * a real screen and re-tune HERE ONLY when the TUI changes.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs raw ESC byte
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences start with ESC ] and end with BEL or ST
const OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: DCS/SOS/PM/APC sequences end with ST (ESC \)
const STRING_SEQ = /\x1b[P^_][\s\S]*?\x1b\\/g;

function stripAnsi(s: string): string {
	return s.replace(STRING_SEQ, "").replace(OSC, "").replace(ANSI, "");
}

/** Strip leading/trailing box-border bars + whitespace so a bordered line ("│ ● Update(x) │") matches. */
const BORDER = /^[\s│|┃╎┆]+|[\s│|┃╎┆]+$/g;
function coreOf(line: string): string {
	return line.replace(BORDER, "");
}

/**
 * How many trailing non-empty lines count as "the tail". The current activity
 * lives at the bottom of the pane; only inspecting the tail keeps an old "●"
 * bullet or "❯" earlier in scrollback from being mistaken for live state.
 */
const TAIL_LINES = 14;

// --- patterns (2.1.x) ------------------------------------------------------

/** A tool line: "● Name(args)" (border already stripped). Name allows MCP/underscore/digits. */
const TOOL = /^●\s+([A-Za-z][\w]*)\((.*)\)$/;

/** Version-stable busy signal: every active spinner frame renders "esc to interrupt". */
const SPINNER_ESC = /esc to interrupt/i;
/** Rotating spinner glyphs (asterisk family) — only count WITH an elapsed timer. */
const SPINNER_GLYPH = /[✻✶✷✸✹✳✺✢✣]/;
/** Whimsical spinner verbs — only count WITH an elapsed timer (non-exhaustive; esc-to-interrupt is the real signal). */
const SPINNER_WORD =
	/\b(?:Cogitat|Ponder|Puzzl|Ruminat|Herd|Think|Work|Reticulat|Comput|Brew|Simmer|Churn|Crunch|Mull|Noodl|Conjur|Divin|Percolat|Spelunk)\w*/i;
/** "(12s" / "(3s · …" elapsed-seconds spinner tail. */
const SPINNER_SECONDS = /\(\s*\d+\s*s\b/;

/** A numbered "❯ 1." selection cursor — the real approval/menu signal (NOT a markdown "> 1."). */
const SELECT_OPTION = /^❯\s*\d+\.\s/;

/** A diff line inside an edit block: optional line-number gutter then +/-. */
const DIFF_LINE = /^\d*\s*[+-]\s/;

/** The rounded input frame (╭──… / ╰──…) that brackets the Claude prompt box. */
const INPUT_FRAME = /[╭╰][─—]{2,}/;
/** An EMPTY input prompt: a bare "❯" or the ghost "❯ Try …" placeholder (NOT "❯ 1." and NOT "❯ realtext"). */
const PROMPT_EMPTY = /^❯\s*$|^[>❯]\s+Try\b/i;

/** Tools whose single arg is a real file path worth surfacing as `data.file`. */
const FILE_TOOLS = /^(?:Read|Write|Edit|Update|Create|MultiEdit|NotebookEdit)$/;

/** A file-ish arg for a file tool: a single token with a path sep or dotted extension. */
function fileFromArg(tool: string, arg: string): string | undefined {
	if (!FILE_TOOLS.test(tool)) {
		return undefined;
	}
	const a = arg.trim();
	if (!a || /\s/.test(a)) {
		return undefined;
	}
	if (a.includes("/") || /\.[A-Za-z0-9]+$/.test(a)) {
		return a;
	}
	return undefined;
}

interface ToolHit {
	tool: string;
	file?: string;
}

/** Find the last tool line in the (border-stripped) tail. */
function lastTool(cores: string[]): ToolHit | null {
	for (let i = cores.length - 1; i >= 0; i--) {
		const m = TOOL.exec(cores[i] ?? "");
		if (m?.[1] !== undefined) {
			const file = fileFromArg(m[1], m[2] ?? "");
			return file ? { tool: m[1], file } : { tool: m[1] };
		}
	}
	return null;
}

export const claudeActivityRecognizer: Recognizer = {
	kind: "claude-activity",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		// capture-pane can return a blank/whitespace screen even while bytes
		// streamed through the tail; fall back to recentBytes in that case.
		const fromScreen = stripAnsi(screen);
		const text = fromScreen.trim() ? fromScreen : stripAnsi(recentBytes);

		const cores = text
			.split(/\r?\n/)
			.map(coreOf)
			.filter((l) => l.trim().length > 0)
			.slice(-TAIL_LINES);
		if (cores.length === 0) {
			return null;
		}
		const tailText = cores.join("\n");

		// 1. AWAITING_INPUT — a "❯ N." selection cursor blocks on a human. Highest
		// priority: an approval (edit / bash / MCP / trust) wins over any tool or
		// spinner line still painted above it. Header wording is NOT required.
		if (cores.some((l) => SELECT_OPTION.test(l))) {
			return { data: { phase: "awaiting_input", detail: "select" }, suggestedKeys: [] };
		}

		const spinner =
			SPINNER_ESC.test(tailText) ||
			(SPINNER_SECONDS.test(tailText) &&
				(SPINNER_GLYPH.test(tailText) || SPINNER_WORD.test(tailText)));
		const tool = lastTool(cores);
		const hasDiff = cores.some((l) => DIFF_LINE.test(l));
		const idleBox = INPUT_FRAME.test(tailText) && cores.some((l) => PROMPT_EMPTY.test(l));

		// 2. IDLE — the empty input box is present and NOTHING is actively working
		// (no spinner). A completed tool/diff bullet left above the box does NOT
		// keep us in "tool" — that is the never-settles bug. Done means done.
		if (idleBox && !spinner) {
			return { data: { phase: "idle", detail: "prompt" }, suggestedKeys: [] };
		}

		// 3. ACTIVE WORK — either a spinner is up, or there is no idle box yet
		// (mid-stream before the box repaints). Classify the active signal.
		if (tool && hasDiff) {
			return {
				data: {
					phase: "editing",
					detail: "diff",
					tool: tool.tool,
					...(tool.file ? { file: tool.file } : {}),
				},
				suggestedKeys: [],
			};
		}
		if (tool) {
			return {
				data: {
					phase: "tool",
					detail: tool.tool,
					tool: tool.tool,
					...(tool.file ? { file: tool.file } : {}),
				},
				suggestedKeys: [],
			};
		}
		if (spinner) {
			return { data: { phase: "thinking", detail: "spinner" }, suggestedKeys: [] };
		}

		// 4. An idle box with no other signal (covers a spinner that just stopped).
		if (idleBox) {
			return { data: { phase: "idle", detail: "prompt" }, suggestedKeys: [] };
		}

		// Nothing recognizable — stay quiet.
		return null;
	},
};
