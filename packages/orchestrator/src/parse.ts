// parse.ts — pure helpers that extract structured signals (sentinels, questions,
// PR URLs, branches) from a captured screen, plus the one-line progress digest.
// Factored out of engineer-loop.ts (P1.3): every function here is pure (string
// in, string/data out) so each is independently testable and importable.
//
// The sentinel markers (TB_LOOP_DONE:, TB_ASK:, TB_PR_URL:, TB_BRANCH_READY:)
// are the machine-readable contract between the engineering prompt and this loop.
// The anchored regexes ensure the marker is the FIRST token on its line (after
// optional indentation and a single TUI bullet like ●/⏺/>/-), which matches
// claude's standalone print but NOT the prompt's echoed instruction line.

import type { AssessResult, ProgressResult } from "./types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping raw ANSI ESC from digest text
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Machine-readable completion marker the engineering prompt instructs claude to print. */
export const DONE_SENTINEL = "TB_LOOP_DONE:";
/** Question relay marker — when claude prints this, the loop relays the question to the operator and blocks for a reply. */
export const ASK_SENTINEL = "TB_ASK:";

// The marker must be the FIRST token on its line (after optional indentation and a
// single TUI bullet like ●/⏺/>/-). That matches claude's standalone print but NOT the
// PROMPT's echoed instruction line ("- When … : TB_LOOP_DONE: PASS"), whose first
// token is "When" — defeating a false "done" from the prompt echoing onto the screen.
const LINE_LEAD = String.raw`^[ \t]*(?:[●⏺▸>*\-]\s+)?`;
const DONE_PASS = new RegExp(`${LINE_LEAD}TB_LOOP_DONE:[ \\t]*PASS\\b`, "im");
const DONE_FAIL = new RegExp(`${LINE_LEAD}TB_LOOP_DONE:[ \\t]*FAIL\\b[ \\t]*(.*)$`, "im");
const ASK_RE = new RegExp(`${LINE_LEAD}TB_ASK:[ \\t]*(.+?)[ \\t]*$`, "im");

/**
 * Extract the latest TB_ASK question from a captured screen, or undefined if none.
 *
 * Returns the LAST TB_ASK marker found, not the first. Claude can ask a second
 * question before the first clears the visible pane (the relay may not have
 * had time to receive and forward the first reply yet) and we must hand the
 * operator the NEWEST question the user actually sees.
 */
export function parseAsk(screen: string): string | undefined {
	// Build the matcher once from the module-level ASK_RE's source + flags,
	// then iterate by advancing a cursor into the ORIGINAL screen (no /g on
	// ASK_RE because the LINE_LEAD leading-anchor + `im` flags make stateful
	// re-exec fragile — slicing the rest is simpler and easier to reason about).
	// V8 caches the compiled regex by (source, flags), so the literal source
	// string is a hit; the per-iteration work is just the cursor advance.
	const r = new RegExp(ASK_RE.source, ASK_RE.flags);
	const src = screen;
	let cursor = 0;
	let last: string | undefined;
	while (cursor <= src.length) {
		const m = r.exec(src.slice(cursor));
		if (!m || m[1] === undefined) break;
		last = m[1];
		cursor += m.index + Math.max(1, m[0].length);
	}
	return last;
}

/** A one-line human digest from a read_progress result. */
export function summarizeProgress(p: ProgressResult): string {
	const icon: Record<string, string> = {
		tool: "🔧",
		editing: "✏️",
		thinking: "…",
		awaiting_input: "⏳",
		idle: "✓",
	};
	const phase = p.phase ?? "working";
	const act = (p.events ?? []).find((e) => e.kind === "claude-activity");
	const tool = typeof act?.data?.tool === "string" ? act.data.tool : undefined;
	const file = typeof act?.data?.file === "string" ? act.data.file : undefined;
	const what = tool ? `${tool}${file ? `(${file})` : ""}` : phase;
	// delta is RAW pane bytes — strip ANSI so the digest is human-readable.
	const lastLine =
		stripAnsi(p.delta ?? "")
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)
			.pop() ?? "";
	return `${icon[phase] ?? "·"} ${what}${lastLine ? ` — ${lastLine.slice(0, 120)}` : ""}`;
}

/** Decide whether a captured screen carries the completion sentinel. */
export function assess(screen: string): AssessResult {
	if (DONE_PASS.test(screen)) {
		return { done: true, pass: true };
	}
	const f = DONE_FAIL.exec(screen);
	if (f) {
		return { done: true, pass: false, reason: f[1]?.trim() || undefined };
	}
	return { done: false, pass: false };
}

// --- delivery (branch → commit → push → PR) ---
const PR_URL_RE = new RegExp(`${LINE_LEAD}TB_PR_URL:[ \\t]*(\\S+)`, "im");
const BRANCH_RE = new RegExp(`${LINE_LEAD}TB_BRANCH_READY:[ \\t]*(\\S+)`, "im");
/** Extract the opened PR URL claude printed, if any (anchored, echo-safe). */
export function parsePrUrl(screen: string): string | undefined {
	return PR_URL_RE.exec(screen)?.[1];
}
/** Extract the committed branch claude printed when it could not push/PR itself. */
export function parseBranch(screen: string): string | undefined {
	return BRANCH_RE.exec(screen)?.[1];
}

/** A safe git branch name derived from the goal (e.g. a ticket title). */
export function slugify(goal: string): string {
	const slug = goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug || "change";
}
