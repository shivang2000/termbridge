// PtyObserver — continuously taps a tmux pane's output and exposes an activity
// clock plus a rolling buffer that powers `waitForIdle` / `waitForText`
// (spec §D6). Production wiring attaches it to `tmux pipe-pane -O <file>` and the
// `readAppended` source reads bytes appended to that temp file since the last
// read. Everything external is injected (clock, readAppended, poll scheduling)
// so the unit is testable WITHOUT real tmux, fs, network, or wall-clock waits.

import type { Clock, ReadOutputResult } from "../types.js";

/** Callback invoked with every non-empty chunk that flows through the observer. */
export type DataCallback = (chunk: string) => void;

/** Async source returning any NEW bytes seen since the previous call. */
export type ReadAppended = () => Promise<string>;

export interface PtyObserverOptions {
	/** Injectable millisecond clock. Defaults to a Date-based monotonic-ish clock. */
	clock?: Clock;
	/**
	 * Source of newly-appended bytes. In production this reads the tail of the
	 * `pipe-pane` temp file; in tests it returns scripted chunks. When omitted,
	 * the poll loop is a no-op (callers may drive the observer via `ingest`).
	 */
	readAppended?: ReadAppended;
	/** Poll interval for the loop started by `start()`. Defaults to 50ms. */
	pollMs?: number;
}

const DEFAULT_POLL_MS = 50;

export class PtyObserver {
	private readonly clock: Clock;
	private readonly readAppended: ReadAppended | undefined;
	private readonly pollMs: number;

	/** Rolling buffer of everything observed so far. */
	private buf = "";
	/** Total bytes ever ingested (monotonic; equals buf.length here). */
	private totalBytes = 0;
	/** Timestamp (clock units) of the most recent ingest. */
	private lastActivity: number;

	private readonly callbacks: DataCallback[] = [];

	private timer: ReturnType<typeof setInterval> | undefined;
	/** Guards against overlapping async reads within the poll loop. */
	private polling = false;

	constructor(opts: PtyObserverOptions = {}) {
		this.clock = opts.clock ?? (() => Date.now());
		this.readAppended = opts.readAppended;
		this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
		// Seed activity at construction time so `waitForIdle` has a sane baseline
		// before any output arrives.
		this.lastActivity = this.clock();
	}

	/**
	 * Append observed bytes to the rolling buffer, advance the byte offset, mark
	 * activity at the current clock value, and notify subscribers. This is the
	 * core seam exercised directly by unit tests.
	 */
	ingest(chunk: string): void {
		// Always record activity — even an empty observation means the pipe was
		// read at this instant.
		this.lastActivity = this.clock();

		if (chunk.length === 0) {
			return;
		}

		this.buf += chunk;
		this.totalBytes += chunk.length;

		// Snapshot subscribers BEFORE delivering so that a callback which
		// subscribes during delivery does not receive the in-flight chunk (and
		// cannot trigger unbounded re-entrant delivery). Each callback is
		// isolated: a throwing subscriber must not starve the others or crash
		// the production pipe-pane data flow.
		const snapshot = this.callbacks.slice();
		for (const cb of snapshot) {
			try {
				cb(chunk);
			} catch {
				// Intentionally swallow — one faulty subscriber must not break
				// the observer. Subscribers own their own error handling.
			}
		}
	}

	/** Subscribe to every non-empty chunk passing through the observer. Returns an unsubscribe fn. */
	onData(cb: DataCallback): () => void {
		this.callbacks.push(cb);
		return () => {
			const i = this.callbacks.indexOf(cb);
			if (i >= 0) {
				this.callbacks.splice(i, 1);
			}
		};
	}

	/** Millisecond timestamp (clock units) of the last ingest. */
	lastActivityAt(): number {
		return this.lastActivity;
	}

	/**
	 * Return the bytes seen since `sinceOffset` along with the new total offset.
	 * Omitting `sinceOffset` (or passing 0 / a negative value) returns the whole
	 * buffer. Offsets beyond the end clamp to an empty slice.
	 */
	buffer(sinceOffset?: number): ReadOutputResult {
		const total = this.totalBytes;

		let from = sinceOffset ?? 0;
		if (from < 0) {
			from = 0;
		}
		if (from > total) {
			from = total;
		}

		return {
			data: this.buf.slice(from),
			nextOffset: total,
		};
	}

	/**
	 * Begin polling `readAppended` and `ingest`-ing any non-empty result. Safe to
	 * call repeatedly — a second call while already running is a no-op. Does
	 * nothing when no `readAppended` source was provided.
	 */
	start(): void {
		if (this.timer !== undefined || this.readAppended === undefined) {
			return;
		}

		this.timer = setInterval(() => {
			void this.pollOnce();
		}, this.pollMs);

		// Don't keep the process alive solely for the observer loop.
		const t = this.timer as unknown as { unref?: () => void };
		if (typeof t.unref === "function") {
			t.unref();
		}
	}

	/** Stop the poll loop. Idempotent. */
	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Read one batch of appended bytes and ingest it; reentrancy-guarded. */
	private async pollOnce(): Promise<void> {
		const read = this.readAppended;
		if (read === undefined || this.polling) {
			return;
		}
		this.polling = true;
		try {
			const chunk = await read();
			if (chunk.length > 0) {
				this.ingest(chunk);
			}
		} catch {
			// A transient read failure (e.g. the pipe-pane temp file is briefly
			// unavailable) must not produce an unhandled rejection or wedge the
			// poll loop. Swallow and retry on the next tick. The `finally` below
			// always releases the reentrancy guard.
		} finally {
			this.polling = false;
		}
	}
}
