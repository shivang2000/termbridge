import type { AgentWriteResult, Clock, WriteLockState } from "../types.js";

export interface WriteLockOptions {
	/** Injectable millisecond clock. Defaults to `Date.now`. */
	clock?: Clock;
	/**
	 * How long after the last human activity the lock stays "human-active".
	 * Defaults to 3000ms.
	 */
	ttlMs?: number;
}

const DEFAULT_TTL_MS = 3000;

/**
 * Advisory human/agent write arbitration.
 *
 * The lock is "human-active" for `ttlMs` after the most recent human keystroke,
 * and "agent" otherwise. While human-active, agent writes are politely refused
 * (the lock is advisory — it never blocks or throws, it just reports). A fresh
 * agent->human flip is announced exactly once via {@link WriteLock.justTookOver}
 * so the Session can emit a single `human_took_over` event per takeover.
 */
export class WriteLock {
	private readonly clock: Clock;
	private readonly ttlMs: number;

	/** clock() timestamp of the last human activity; -Infinity means "never". */
	private lastHumanAt = Number.NEGATIVE_INFINITY;

	/** True once the current takeover has been announced by justTookOver(). */
	private announced = true;

	constructor(opts: WriteLockOptions = {}) {
		this.clock = opts.clock ?? Date.now;
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	}

	/** Stamp the current time as the last human activity. */
	noteHumanActivity(): void {
		// A "fresh flip" is human activity that arrives while the lock is NOT
		// currently human-active (initial state, or after the window lapsed).
		// Only a fresh flip arms a new announcement.
		if (this.state() !== "human-active") {
			this.announced = false;
		}
		this.lastHumanAt = this.clock();
	}

	/**
	 * "human-active" while within `ttlMs` of the last human activity, else "agent".
	 * Initial state is "agent".
	 */
	state(): WriteLockState {
		return this.clock() - this.lastHumanAt < this.ttlMs ? "human-active" : "agent";
	}

	/**
	 * Attempt an agent write. Returns `{ ok: true }` when the agent owns the lock,
	 * otherwise `{ ok: false, error: "human_driving" }`. Never throws.
	 */
	tryAgentWrite(): AgentWriteResult {
		if (this.state() === "agent") {
			return { ok: true };
		}
		return { ok: false, error: "human_driving" };
	}

	/**
	 * True exactly once after a fresh agent->human flip, then false until the next
	 * fresh flip. Returns false if the lock is not currently human-active.
	 */
	justTookOver(): boolean {
		if (this.state() !== "human-active") {
			return false;
		}
		if (this.announced) {
			return false;
		}
		this.announced = true;
		return true;
	}
}
