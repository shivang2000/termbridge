// types.ts — the public + internal shapes of the engineer-loop. Factored out of
// engineer-loop.ts (P1.3) so the loop driver, parsers, prompt builders, and
// approval glue each import the single source of truth for every shape.

/** Backend-agnostic tool caller: maps a termbridge tool name + args to its result. */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

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
	/**
	 * Called when claude prints `TB_ASK: <question>` (a question relay). MUST
	 * resolve to the text the operator forwards BACK into the claude terminal —
	 * the loop will `send_text` it verbatim. Forward the question to the user,
	 * block until they reply, then return that reply. A relay is NOT a turn
	 * boundary: claude may keep working after it receives the answer.
	 */
	onAsk?: (q: { question: string; sessionId: string }) => Promise<string>;
	/** Called when the task has no acceptance criteria — elicit them from the user. */
	elicitAcceptance?: () => Promise<string[]>;
	/** Optional structured logger. */
	log?: (m: string) => void;
	/**
	 * After acceptance is met, deliver the change: claude creates a branch + commits,
	 * and (if `gh` is authenticated in the session) pushes + opens a PR. Default false
	 * (the loop only edits+verifies); the CLI/skill enable it.
	 * Prefer {@link delivery} for new code; `openPr: true` is sugar for `delivery: "gh-pr"`.
	 */
	openPr?: boolean;
	/**
	 * Delivery target after acceptance (Phase 3). `"gh-pr"` (default when openPr),
	 * `"patch"` (raw unified patch markers), `"gerrit"`, `"none"`, or a custom strategy.
	 */
	delivery?: "gh-pr" | "patch" | "gerrit" | "none" | import("./delivery.js").DeliveryStrategy;
	/** Branch to deliver on. Defaults to `tb/<slug of goal>`. */
	branch?: string;
	/** Force a draft PR. Otherwise the PR is "ready" only when {@link confirmPr} returns true. */
	prDraft?: boolean;
	/**
	 * Human gate before opening the PR (outward action). Returns true → ready PR;
	 * false or absent → draft PR. Use it to ask the user in chat / at the CLI.
	 */
	confirmPr?: () => Promise<boolean>;
}

export interface EngineerLoopResult {
	met: boolean;
	rounds: number;
	acceptance: string[];
	finalSummary: string;
	testReport?: string;
	sessionId: string;
	/** What delivery produced: a PR, a pushed/committed branch, a patch, or nothing. */
	delivery?: "pr" | "branch" | "patch" | "none";
	/** The opened PR / review URL (when delivery === "pr"). */
	prUrl?: string;
	/** The branch claude committed to (for host-side push/PR fallback). */
	branch?: string;
	/** Raw patch body or file path when delivery === "patch". */
	patch?: string;
}

export interface AssessResult {
	done: boolean;
	pass: boolean;
	reason?: string;
}

// --- minimal result shapes for the tools the loop calls ---
export interface OpenResult {
	id: string;
}
export interface IdleResult {
	idle: boolean;
}
export interface ScreenResult {
	screen: string;
}
export interface ActivityEvent {
	kind: string;
	data?: { tool?: unknown; file?: unknown; phase?: unknown };
}
export interface ProgressResult {
	delta?: string;
	nextOffset?: number;
	events?: ActivityEvent[];
	phase?: string | null;
	awaitingInput?: boolean;
	idle?: boolean;
}
