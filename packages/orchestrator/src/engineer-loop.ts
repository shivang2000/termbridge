// engineer-loop — a backend-agnostic, iterate-until-done driving loop for a
// Claude Code session piloted through termbridge's tool surface (M7, Phase B).
//
// D8: termbridge core stays primitives; THIS is consumer code (the "loop" the
// spec says lives outside core). It talks to termbridge only through a
// {@link ToolCall} — so the same loop runs over the stdio MCP client, the
// unified server's HTTP tool API, or an in-process createToolSpecs dispatch.
//
// The loop: open a session → let claude boot → approve the trust gate → send a
// structured engineering prompt carrying the goal + acceptance criteria → pump
// the turn (poll progress on a cadence, auto-approving permission prompts and
// emitting digests) until the session goes idle → check for the machine-readable
// completion sentinel → if not done, send a corrective nudge and loop, bounded
// by maxRounds. Round-complete is decided by wait_for_idle (the robust,
// clock-based signal), NOT by read_progress.idle.

/** Backend-agnostic tool caller: maps a termbridge tool name + args to its result. */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping raw ANSI ESC from digest text
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

export interface EngineerTask {
	/** What to build/fix. */
	goal: string;
	/** Acceptance criteria — ALL must hold before the loop reports success. */
	acceptance?: string[];
	/** Working directory bound to the session (a repo path). */
	cwd: string;
	/** Execution backend. Defaults to "docker" (container isolation). */
	env?: "local" | "docker";
	/** The interactive program to pilot. Defaults to "claude". */
	cmd?: string;
	/** Optional explicit verification command (e.g. "bun test"); else claude finds the project's tests. */
	verifyCmd?: string;
}

/** A streamed progress update, one per cadence tick (or turn boundary). */
export interface Digest {
	round: number;
	phase: string | null;
	summary: string;
	idle: boolean;
}

export interface EngineerLoopOptions {
	tools: ToolCall;
	task: EngineerTask;
	/** Max wall-clock between digests while claude is working. Default 25_000ms. */
	cadenceMs?: number;
	/** Max engineering rounds (a round = one turn + a corrective nudge). Default 6. */
	maxRounds?: number;
	/** Quiet window that marks a turn complete. Default 4_000ms. */
	quietMs?: number;
	/** How long to wait for the claude TUI to boot. Default 120_000ms. */
	bootTimeoutMs?: number;
	/** Hard ceiling on a single turn's pump (guards a turn that never goes idle). Default 600_000ms. */
	turnTimeoutMs?: number;
	/** Called for every digest tick — relay this to the user (Discord, web, stdout). */
	onDigest?: (d: Digest) => void;
	/** Called when the task has no acceptance criteria — elicit them from the user. */
	elicitAcceptance?: () => Promise<string[]>;
	/** Optional structured logger. */
	log?: (m: string) => void;
}

export interface EngineerLoopResult {
	met: boolean;
	rounds: number;
	acceptance: string[];
	finalSummary: string;
	testReport?: string;
	sessionId: string;
}

/** Machine-readable completion marker the engineering prompt instructs claude to print. */
export const DONE_SENTINEL = "TB_LOOP_DONE:";
// The marker must be the FIRST token on its line (after optional indentation and a
// single TUI bullet like ●/⏺/>/-). That matches claude's standalone print but NOT the
// PROMPT's echoed instruction line ("- When … : TB_LOOP_DONE: PASS"), whose first
// token is "When" — defeating a false "done" from the prompt echoing onto the screen.
const LINE_LEAD = String.raw`^[ \t]*(?:[●⏺▸>*\-]\s+)?`;
const DONE_PASS = new RegExp(`${LINE_LEAD}TB_LOOP_DONE:[ \\t]*PASS\\b`, "im");
const DONE_FAIL = new RegExp(`${LINE_LEAD}TB_LOOP_DONE:[ \\t]*FAIL\\b[ \\t]*(.*)$`, "im");

/** Build the structured engineering prompt sent to claude at the start of the loop. */
export function buildEngineerPrompt(task: EngineerTask, acceptance: string[]): string {
	const criteria = acceptance.length
		? acceptance.map((a) => `- ${a}`).join("\n")
		: "- (none specified — infer reasonable criteria from the goal and the repo)";
	const verify = task.verifyCmd
		? `Verify your work by running: ${task.verifyCmd}`
		: "Find and run the project's tests/build to verify your work.";
	return [
		"You are an autonomous software engineer working in this repository. Complete the goal end to end.",
		"",
		"GOAL:",
		task.goal,
		"",
		"ACCEPTANCE CRITERIA (ALL must hold before you finish):",
		criteria,
		"",
		"RULES:",
		"- Work step by step; edit files and run commands as needed.",
		`- ${verify}`,
		`- When (and ONLY when) EVERY acceptance criterion holds AND your verification passes, print a line that STARTS with the marker (nothing before it on that line): ${DONE_SENTINEL} PASS`,
		`- If the task genuinely cannot be completed, instead print a line that starts with: ${DONE_SENTINEL} FAIL <one-line reason>`,
		`- Do NOT print the ${DONE_SENTINEL} marker until you have actually run the verification.`,
	].join("\n");
}

/** Build the corrective nudge sent when a turn ended without the completion sentinel. */
export function correctivePrompt(acceptance: string[], assessed: AssessResult): string {
	if (assessed.done && !assessed.pass) {
		return [
			"You printed a FAIL. Re-examine the goal and try a different approach.",
			assessed.reason ? `Your stated blocker: ${assessed.reason}` : "",
			`When every criterion holds and verification passes, print "${DONE_SENTINEL} PASS".`,
		]
			.filter(Boolean)
			.join("\n");
	}
	const criteria = acceptance.length
		? `\nRemaining criteria:\n${acceptance.map((a) => `- ${a}`).join("\n")}`
		: "";
	return [
		"Continue. You have not yet printed the completion sentinel.",
		"Finish the remaining work, RUN the verification, and only then print",
		`"${DONE_SENTINEL} PASS" (or "${DONE_SENTINEL} FAIL <reason>" if blocked).${criteria}`,
	].join("\n");
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

export interface AssessResult {
	done: boolean;
	pass: boolean;
	reason?: string;
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

// --- minimal result shapes for the tools the loop calls ---
interface OpenResult {
	id: string;
}
interface IdleResult {
	idle: boolean;
}
interface ScreenResult {
	screen: string;
}
interface ActivityEvent {
	kind: string;
	data?: { tool?: unknown; file?: unknown; phase?: unknown };
}
interface ProgressResult {
	delta?: string;
	nextOffset?: number;
	events?: ActivityEvent[];
	phase?: string | null;
	awaitingInput?: boolean;
	idle?: boolean;
}

/** If the session is blocked on an approval, accept the highlighted default (Yes). */
async function approveIfBlocked(tools: ToolCall, id: string): Promise<boolean> {
	const p = (await tools("read_progress", { id, sinceOffset: 0 })) as ProgressResult;
	if (p.awaitingInput || p.phase === "awaiting_input") {
		await tools("send_control", { id, key: "Enter" });
		await tools("wait_for_idle", { id, quietMs: 1500, timeoutMs: 30000 });
		return true;
	}
	return false;
}

/**
 * Run the engineering loop to completion (or budget exhaustion). Does NOT close
 * the session — the caller owns teardown (so a watcher can keep observing).
 */
export async function runEngineerLoop(opts: EngineerLoopOptions): Promise<EngineerLoopResult> {
	const { tools, task } = opts;
	const cadenceMs = opts.cadenceMs ?? 25_000;
	const maxRounds = opts.maxRounds ?? 6;
	const quietMs = opts.quietMs ?? 4_000;
	const bootTimeoutMs = opts.bootTimeoutMs ?? 120_000;
	const turnTimeoutMs = opts.turnTimeoutMs ?? 600_000;
	const maxTurnTicks = Math.max(1, Math.ceil(turnTimeoutMs / cadenceMs));
	const onDigest = opts.onDigest ?? (() => {});
	const log = opts.log ?? (() => {});

	let acceptance = task.acceptance ?? [];
	if (acceptance.length === 0 && opts.elicitAcceptance) {
		acceptance = await opts.elicitAcceptance();
		log(`elicited ${acceptance.length} acceptance criteria`);
	}

	const opened = (await tools("open_session", {
		env: task.env ?? "docker",
		cwd: task.cwd,
		cmd: task.cmd ?? "claude",
	})) as OpenResult;
	const id = opened.id;
	log(`opened session ${id}`);

	// Let the TUI boot, then clear the folder-trust gate if it's up.
	await tools("wait_for_idle", { id, quietMs: 2500, timeoutMs: bootTimeoutMs });
	await approveIfBlocked(tools, id);

	await tools("send_text", { id, text: buildEngineerPrompt(task, acceptance), enter: true });

	let offset = 0;
	let met = false;
	let reason: string | undefined;
	let report: string | undefined;
	let roundsRun = 0;

	for (let round = 1; round <= maxRounds; round++) {
		roundsRun = round;
		// Pump the turn: tick on the cadence, approving prompts + emitting digests,
		// until wait_for_idle says the turn is complete (the authoritative signal).
		// A per-turn tick ceiling guards a turn that never goes idle (runaway output
		// or a re-painting prompt) from spinning forever.
		let ticks = 0;
		for (;;) {
			if (ticks++ >= maxTurnTicks) {
				log(`turn ${round} hit the ${turnTimeoutMs}ms ceiling without going idle; moving on`);
				break;
			}
			const idleRes = (await tools("wait_for_idle", {
				id,
				quietMs,
				timeoutMs: cadenceMs,
			})) as IdleResult;
			const p = (await tools("read_progress", { id, sinceOffset: offset })) as ProgressResult;
			offset = p.nextOffset ?? offset;
			onDigest({
				round,
				phase: p.phase ?? null,
				summary: summarizeProgress(p),
				idle: !!idleRes.idle,
			});
			if (p.awaitingInput || p.phase === "awaiting_input") {
				await tools("send_control", { id, key: "Enter" }); // approve default (Yes)
				continue;
			}
			if (idleRes.idle) {
				break; // turn complete
			}
		}

		// Scrollback so a sentinel that scrolled past the visible tail is still seen;
		// the anchored regex keeps the echoed prompt instruction from matching.
		const { screen } = (await tools("read_screen", { id, scrollback: 200 })) as ScreenResult;
		const a = assess(screen);
		if (a.done && a.pass) {
			met = true;
			report = "verification passed (TB_LOOP_DONE: PASS)";
			break;
		}
		if (a.done && !a.pass) {
			reason = a.reason;
		}
		if (round < maxRounds) {
			await tools("send_text", { id, text: correctivePrompt(acceptance, a), enter: true });
		}
	}

	const finalSummary = met
		? `acceptance met after ${roundsRun} round(s)`
		: `not met after ${roundsRun} round(s)${reason ? ` (claude: ${reason})` : ""}`;
	log(finalSummary);
	return { met, rounds: roundsRun, acceptance, finalSummary, testReport: report, sessionId: id };
}
