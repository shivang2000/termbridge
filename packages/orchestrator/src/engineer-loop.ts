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
//
// Factored (P1.3): the types, parsers, prompt builders, and approval glue now
// live in focused sibling modules (`./types.js`, `./parse.js`, `./prompt.js`,
// `./approve.js`); this file is the loop driver + the public re-export barrel so
// `import { … } from "./engineer-loop.js"` (the test file) and `export * from
// "./engineer-loop.js"` (`index.ts`) see an unchanged API.

import { approveIfBlocked } from "./approve.js";
import { assess, parseAsk, parseBranch, parsePrUrl, slugify, summarizeProgress } from "./parse.js";
import { buildDeliveryPrompt, buildEngineerPrompt, correctivePrompt } from "./prompt.js";
import type {
	EngineerLoopOptions,
	EngineerLoopResult,
	IdleResult,
	OpenResult,
	ProgressResult,
	ScreenResult,
} from "./types.js";

// Re-export the full public surface so callers importing from
// "./engineer-loop.js" (the test file) or via index.ts (`export * from
// "./engineer-loop.js"`) see an unchanged API after the P1.3 split. The value
// imports above bring only what `runEngineerLoop` itself uses into scope; the
// re-exports below are separate (`export { x } from "…"` does NOT bring `x`
// into local scope).
export {
	ASK_SENTINEL,
	assess,
	DONE_SENTINEL,
	parseAsk,
	parseBranch,
	parsePrUrl,
	slugify,
	summarizeProgress,
} from "./parse.js";
export { buildDeliveryPrompt, buildEngineerPrompt, correctivePrompt } from "./prompt.js";
export type {
	AssessResult,
	Digest,
	EngineerLoopOptions,
	EngineerLoopResult,
	EngineerTask,
	ToolCall,
} from "./types.js";

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
		let lastAskedQuestion: string | undefined;
		for (;;) {
			if (ticks++ >= maxTurnTicks) {
				log(`turn ${round} hit the ${turnTimeoutMs}ms ceiling without going idle; moving on`);
				break;
			}
			// Question relay FIRST (before waiting for idle). If claude is blocked on a
			// TB_ASK, the screen is idle by definition and we'd otherwise wait the full
			// cadence to notice. Re-read the screen on every tick so a freshly printed
			// TB_ASK surfaces within one cadence of being painted.
			if (opts.onAsk) {
				const { screen: askScreen } = (await tools("read_screen", {
					id,
					scrollback: 100,
				})) as ScreenResult;
				const question = parseAsk(askScreen);
				if (question && question !== lastAskedQuestion) {
					lastAskedQuestion = question;
					log(`relay TB_ASK: ${question}`);
					const reply = await opts.onAsk({ question, sessionId: id });
					if (reply && reply.length > 0) {
						await tools("send_text", { id, text: reply, enter: true });
						log(`relayed reply (${reply.length} chars)`);
					}
					// A reply is NOT a turn boundary — claude may run more after it.
					// Reset ticks so the relay does not consume the per-turn ceiling.
					ticks = 0;
					continue;
				}
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

	// Delivery: after acceptance is met, optionally branch → commit → push → PR.
	// Opening a PR is an outward action, so it's gated: `confirmPr` true → ready PR,
	// otherwise (declined / no human / prDraft) → draft. If gh isn't authenticated in
	// the session, claude only commits a branch and the caller pushes + PRs on the host.
	let delivery: "pr" | "branch" | "none" = "none";
	let prUrl: string | undefined;
	let deliveredBranch: string | undefined;
	if (met && (opts.openPr ?? false)) {
		const ready = opts.prDraft ? false : opts.confirmPr ? await opts.confirmPr() : false;
		const branch = opts.branch ?? `tb/${slugify(task.goal)}`;
		deliveredBranch = branch;
		log(`delivering on ${branch} (PR ${ready ? "ready" : "draft"})`);
		await tools("send_text", { id, text: buildDeliveryPrompt(branch, !ready), enter: true });
		let ticks = 0;
		for (;;) {
			if (ticks++ >= maxTurnTicks) {
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
				round: roundsRun,
				phase: p.phase ?? null,
				summary: summarizeProgress(p),
				idle: !!idleRes.idle,
			});
			if (p.awaitingInput || p.phase === "awaiting_input") {
				await tools("send_control", { id, key: "Enter" });
				continue;
			}
			if (idleRes.idle) {
				break;
			}
		}
		const { screen } = (await tools("read_screen", { id, scrollback: 300 })) as ScreenResult;
		prUrl = parsePrUrl(screen);
		const br = parseBranch(screen);
		if (br) {
			deliveredBranch = br;
		}
		delivery = prUrl ? "pr" : br ? "branch" : "none";
	}

	const deliverySummary = prUrl
		? ` → PR ${prUrl}`
		: delivery === "branch"
			? ` → branch ${deliveredBranch} (push + PR on host)`
			: "";
	const finalSummary = met
		? `acceptance met after ${roundsRun} round(s)${deliverySummary}`
		: `not met after ${roundsRun} round(s)${reason ? ` (claude: ${reason})` : ""}`;
	log(finalSummary);
	return {
		met,
		rounds: roundsRun,
		acceptance,
		finalSummary,
		testReport: report,
		sessionId: id,
		delivery,
		...(prUrl ? { prUrl } : {}),
		...(deliveredBranch ? { branch: deliveredBranch } : {}),
	};
}
