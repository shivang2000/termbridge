// Session — the human/agent-shared interactive terminal (spec §6). It composes
// the four primitives:
//
//   • Environment        — issues tmux CLI (send-keys, capture-pane, resize…)
//   • PtyObserver        — rolling output buffer + activity clock (idle/wait)
//   • RecognizerPipeline — turns screen state into structured RecognizedEvents
//   • WriteLock          — advisory human/agent write arbitration
//
// Everything time-related is injected (clock + sleep) so waitForIdle /
// waitForText are unit-testable WITHOUT real timers, and the whole class is
// driven through a mocked Environment + a fake observer in tests.

import type { PtyObserver } from "../observer/pty-observer.js";
import type { RecognizerPipeline } from "../recognizers/pipeline.js";
import type {
	Clock,
	EventsResult,
	IdleResult,
	ReadOutputResult,
	ReadScreenOptions,
	RecognizedEvent,
	SendOptions,
	SendResult,
	WaitTextResult,
	WriteLockState,
} from "../types.js";
import type { WriteLock } from "./write-lock.js";

/** Minimal view of `Environment` that `Session` actually needs (keeps deps loose). */
export interface SessionEnvironment {
	tmux(args: string[]): Promise<import("../types.js").ExecResult>;
	destroySession(name: string): Promise<void>;
}

/** Async sleep, injectable so wait-loops never block on real wall-clock time. */
export type Sleep = (ms: number) => Promise<void>;

export interface SessionDeps {
	/** Registry id (SessionManager-assigned). Defaults to `name` when omitted. */
	id?: string;
	/** tmux session name this Session drives. */
	name: string;
	env: SessionEnvironment;
	observer: PtyObserver;
	pipeline: RecognizerPipeline;
	writeLock: WriteLock;
	/** Injectable millisecond clock (defaults to Date.now). */
	clock?: Clock;
	/** Injectable sleep (defaults to setTimeout). */
	sleep?: Sleep;
	/** Poll interval for waitForIdle / waitForText (defaults to 25ms). */
	pollMs?: number;
	/**
	 * When true, auto-answer routine permission prompts in-session (so a driving
	 * agent that polls only occasionally never leaves the TUI stuck). Login is
	 * never auto-answered; a human takeover pauses it via the WriteLock. Default off.
	 */
	autoApprove?: boolean;
	/** Settle delay before an auto-approve check fires after output (default 200ms). */
	autoApproveSettleMs?: number;
}

const DEFAULT_POLL_MS = 25;
const DEFAULT_IDLE_QUIET_MS = 400;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_AUTO_APPROVE_SETTLE_MS = 200;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Session {
	readonly id: string;
	readonly name: string;
	private readonly env: SessionEnvironment;
	private readonly observer: PtyObserver;
	private readonly pipeline: RecognizerPipeline;
	private readonly writeLock: WriteLock;
	private readonly clock: Clock;
	private readonly sleep: Sleep;
	private readonly pollMs: number;

	/** Events queued for the next readEvents() — human_took_over, needs_login, … */
	private pendingEvents: RecognizedEvent[] = [];

	// --- auto-approve state (only used when deps.autoApprove) ---
	private readonly autoApproveSettleMs: number;
	private autoApproveUnsub: (() => void) | undefined;
	private autoApproveScheduled = false;
	/** Signature of the prompt instance we last auto-answered; cleared when the prompt clears. */
	private lastApprovedSig: string | null = null;
	private closed = false;

	constructor(deps: SessionDeps) {
		this.id = deps.id ?? deps.name;
		this.name = deps.name;
		this.env = deps.env;
		this.observer = deps.observer;
		this.pipeline = deps.pipeline;
		this.writeLock = deps.writeLock;
		this.clock = deps.clock ?? Date.now;
		this.sleep = deps.sleep ?? realSleep;
		this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
		this.autoApproveSettleMs = deps.autoApproveSettleMs ?? DEFAULT_AUTO_APPROVE_SETTLE_MS;
		if (deps.autoApprove) {
			this.startAutoApprove();
		}
	}

	/**
	 * Type text into the session as the agent. Gated by the WriteLock: while a
	 * human is driving the agent write is politely refused (never throws) and a
	 * one-shot `human_took_over` event is queued for the next readEvents().
	 */
	async sendText(text: string, opts: SendOptions = {}): Promise<SendResult> {
		const gate = this.guardAgentWrite();
		if (!gate.ok) {
			return gate;
		}

		await this.env.tmux(["send-keys", "-t", this.name, "-l", text]);
		if (opts.enter !== false) {
			await this.env.tmux(["send-keys", "-t", this.name, "Enter"]);
		}
		return { ok: true };
	}

	/** Send a control / named key (e.g. "C-c", "Up", "Enter"). Same write-gate. */
	async sendControl(key: string): Promise<SendResult> {
		const gate = this.guardAgentWrite();
		if (!gate.ok) {
			return gate;
		}
		await this.env.tmux(["send-keys", "-t", this.name, key]);
		return { ok: true };
	}

	/** Capture the current visible pane (optionally including scrollback / ANSI escapes). */
	async readScreen(opts: ReadScreenOptions = {}): Promise<string> {
		const args = ["capture-pane", "-p", "-t", this.name];
		if (opts.escapes) {
			args.push("-e");
		}
		if (opts.scrollback !== undefined) {
			args.push("-S", `-${opts.scrollback}`);
		}
		const res = await this.env.tmux(args);
		return res.stdout;
	}

	/**
	 * Mark that a human is interacting (web bridge calls this on every keystroke).
	 * Flips the WriteLock so the agent's next write is refused with `human_driving`.
	 */
	noteHumanActivity(): void {
		this.writeLock.noteHumanActivity();
	}

	/**
	 * Current advisory write-lock holder (`agent` | `human-active`). Used by
	 * fleet inventory (GET /api/sessions) — does not invent new state.
	 */
	lockState(): WriteLockState {
		return this.writeLock.state();
	}

	/**
	 * Inject raw human keystrokes (xterm byte stream) into the pane. NOT write-
	 * gated — the human always wins; this is exactly what flips the agent to
	 * `human_driving`. Bytes are sent literally (`send-keys -l`), so arrow/control
	 * sequences pass through to the TUI as typed.
	 */
	async sendHumanInput(data: string): Promise<void> {
		this.noteHumanActivity();
		await this.env.tmux(["send-keys", "-t", this.name, "-l", data]);
	}

	/** Subscribe to live pane output (pipe-pane stream). Returns an unsubscribe fn. */
	onOutput(cb: (chunk: string) => void): () => void {
		return this.observer.onData(cb);
	}

	/** Bytes appended to the rolling observer buffer since `sinceOffset`. */
	readNewOutput(opts: { sinceOffset?: number } = {}): ReadOutputResult {
		return this.observer.buffer(opts.sinceOffset);
	}

	/** Millisecond timestamp of the observer's most recent output activity. */
	lastActivityAt(): number {
		return this.observer.lastActivityAt();
	}

	/**
	 * Resolve once the session has been quiet for `quietMs`, or `{ idle:false }`
	 * at `timeoutMs`. Never hangs: bounded by timeout, polled via injected sleep.
	 */
	async waitForIdle(
		quietMs: number = DEFAULT_IDLE_QUIET_MS,
		timeoutMs: number = DEFAULT_TIMEOUT_MS,
	): Promise<IdleResult> {
		const startedAt = this.clock();

		for (;;) {
			const now = this.clock();
			const waitedMs = now - startedAt;
			const sinceActivity = now - this.observer.lastActivityAt();

			if (sinceActivity >= quietMs) {
				return { idle: true, waitedMs };
			}
			if (waitedMs >= timeoutMs) {
				return { idle: false, waitedMs };
			}
			await this.sleep(this.pollMs);
		}
	}

	/**
	 * Poll the captured screen until `pattern` (string or RegExp) matches, or
	 * `timeoutMs` elapses. Returns `{ matched, screen }` with the last screen
	 * seen. Never hangs.
	 */
	async waitForText(
		pattern: string | RegExp,
		timeoutMs: number = DEFAULT_TIMEOUT_MS,
	): Promise<WaitTextResult> {
		const startedAt = this.clock();
		let screen = "";

		for (;;) {
			screen = await this.readScreen();
			if (this.matches(screen, pattern)) {
				return { matched: true, screen };
			}
			if (this.clock() - startedAt >= timeoutMs) {
				return { matched: false, screen };
			}
			await this.sleep(this.pollMs);
		}
	}

	/**
	 * Collect newly-recognized events. Feeds the screen + the bytes appended
	 * since `sinceOffset` through the recognizer pipeline, prepends any queued
	 * `human_took_over` events, and returns the advanced offset so the caller can
	 * poll incrementally (mirrors EventsResult).
	 */
	async readEvents(opts: { sinceOffset?: number } = {}): Promise<EventsResult> {
		const screen = await this.readScreen();
		const { data: recentBytes, nextOffset } = this.observer.buffer(opts.sinceOffset);

		const queued = this.pendingEvents;
		this.pendingEvents = [];

		const recognized = this.pipeline.process(screen, recentBytes);

		return { events: [...queued, ...recognized], nextOffset };
	}

	/**
	 * Queue an out-of-band event (e.g. needs_login) for the next readEvents().
	 * Used by SessionManager to surface state the recognizers can't see on screen.
	 */
	queueEvent(event: RecognizedEvent): void {
		this.pendingEvents.push(event);
	}

	/** Resize the tmux window (live resize is honoured by attached humans). */
	async resize(cols: number, rows: number): Promise<void> {
		await this.env.tmux(["resize-window", "-t", this.name, "-x", String(cols), "-y", String(rows)]);
	}

	/** Stop observing and tear down the underlying tmux session. */
	async close(): Promise<void> {
		this.closed = true;
		this.autoApproveUnsub?.();
		this.autoApproveUnsub = undefined;
		this.observer.stop();
		await this.env.destroySession(this.name);
	}

	// --- auto-approve -------------------------------------------------------
	// Answer the TUI's routine permission prompts in-session so a driving agent
	// that polls only occasionally never leaves Claude stuck. Subscribes to the
	// live pane stream; on a settled burst it recognizes a claude-permission
	// prompt and sends the recognizer's suggested key — but ONLY through the
	// WriteLock-gated sendControl, so a human takeover pauses it for free, and
	// login (paste/oauth → empty suggestedKeys) is never auto-answered.

	private startAutoApprove(): void {
		this.autoApproveUnsub = this.observer.onData(() => this.scheduleApproveCheck());
	}

	/** Coalesce a burst of output into a single settled check (debounce). */
	private scheduleApproveCheck(): void {
		if (this.autoApproveScheduled || this.closed) {
			return;
		}
		this.autoApproveScheduled = true;
		void (async () => {
			await this.sleep(this.autoApproveSettleMs);
			this.autoApproveScheduled = false;
			if (!this.closed) {
				await this.checkAndApprove().catch(() => {
					// A transient capture/send failure must not kill the observer loop.
				});
			}
		})();
	}

	private async checkAndApprove(): Promise<void> {
		const screen = await this.readScreen();
		const { data: recentBytes } = this.observer.buffer();
		const perm = this.pipeline
			.process(screen, recentBytes)
			.find((e) => e.kind === "claude-permission" && e.suggestedKeys.length > 0);

		if (!perm) {
			// Prompt cleared → allow the next (possibly identically-worded) prompt.
			this.lastApprovedSig = null;
			return;
		}

		const question = (perm.data as { question?: string } | undefined)?.question ?? "";
		const sig = `${perm.kind}:${question}`;
		if (sig === this.lastApprovedSig) {
			return; // already answered this on-screen prompt instance
		}

		// Write-gated: refused while a human is driving → we simply don't mark it,
		// so the human keeps control and we retry once they release.
		const res = await this.sendControl(perm.suggestedKeys[0] as string);
		if (res.ok) {
			this.lastApprovedSig = sig;
		}
	}

	/**
	 * Shared write gate. Refuses the write while a human is driving and, on a
	 * fresh takeover, queues exactly one `human_took_over` event.
	 */
	private guardAgentWrite(): SendResult {
		const attempt = this.writeLock.tryAgentWrite();
		if (attempt.ok) {
			return { ok: true };
		}
		if (this.writeLock.justTookOver()) {
			this.pendingEvents.push({
				kind: "human_took_over",
				data: {},
				suggestedKeys: [],
			});
		}
		return { ok: false, error: "human_driving" };
	}

	private matches(screen: string, pattern: string | RegExp): boolean {
		return typeof pattern === "string" ? screen.includes(pattern) : pattern.test(screen);
	}
}
