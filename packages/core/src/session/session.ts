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
}

const DEFAULT_POLL_MS = 25;
const DEFAULT_IDLE_QUIET_MS = 400;
const DEFAULT_TIMEOUT_MS = 30_000;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Session {
	readonly name: string;
	private readonly env: SessionEnvironment;
	private readonly observer: PtyObserver;
	private readonly pipeline: RecognizerPipeline;
	private readonly writeLock: WriteLock;
	private readonly clock: Clock;
	private readonly sleep: Sleep;
	private readonly pollMs: number;

	/** Queued human_took_over events awaiting collection by readEvents(). */
	private pendingTakeovers: RecognizedEvent[] = [];

	constructor(deps: SessionDeps) {
		this.name = deps.name;
		this.env = deps.env;
		this.observer = deps.observer;
		this.pipeline = deps.pipeline;
		this.writeLock = deps.writeLock;
		this.clock = deps.clock ?? Date.now;
		this.sleep = deps.sleep ?? realSleep;
		this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
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

	/** Capture the current visible pane (optionally including scrollback). */
	async readScreen(opts: ReadScreenOptions = {}): Promise<string> {
		const args = ["capture-pane", "-p", "-t", this.name];
		if (opts.scrollback !== undefined) {
			args.push("-S", `-${opts.scrollback}`);
		}
		const res = await this.env.tmux(args);
		return res.stdout;
	}

	/** Bytes appended to the rolling observer buffer since `sinceOffset`. */
	readNewOutput(opts: { sinceOffset?: number } = {}): ReadOutputResult {
		return this.observer.buffer(opts.sinceOffset);
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

		const takeovers = this.pendingTakeovers;
		this.pendingTakeovers = [];

		const recognized = this.pipeline.process(screen, recentBytes);

		return { events: [...takeovers, ...recognized], nextOffset };
	}

	/** Resize the tmux window (live resize is honoured by attached humans). */
	async resize(cols: number, rows: number): Promise<void> {
		await this.env.tmux(["resize-window", "-t", this.name, "-x", String(cols), "-y", String(rows)]);
	}

	/** Stop observing and tear down the underlying tmux session. */
	async close(): Promise<void> {
		this.observer.stop();
		await this.env.destroySession(this.name);
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
			this.pendingTakeovers.push({
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
