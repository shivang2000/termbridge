import { beforeEach, describe, expect, test } from "bun:test";
import type { Clock } from "../types.js";
import { WriteLock } from "./write-lock.js";

/** A controllable fake clock for deterministic tests. */
function makeClock(start = 0): {
	clock: Clock;
	advance: (ms: number) => void;
	set: (ms: number) => void;
} {
	let now = start;
	return {
		clock: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		set: (ms: number) => {
			now = ms;
		},
	};
}

describe("WriteLock", () => {
	let fake: ReturnType<typeof makeClock>;

	beforeEach(() => {
		fake = makeClock(0);
	});

	test("initial state is agent", () => {
		const lock = new WriteLock({ clock: fake.clock });
		expect(lock.state()).toBe("agent");
	});

	test("tryAgentWrite succeeds while agent owns the lock", () => {
		const lock = new WriteLock({ clock: fake.clock });
		expect(lock.tryAgentWrite()).toEqual({ ok: true });
	});

	test("noteHumanActivity flips state to human-active and blocks agent writes", () => {
		const lock = new WriteLock({ clock: fake.clock });
		lock.noteHumanActivity();
		expect(lock.state()).toBe("human-active");
		expect(lock.tryAgentWrite()).toEqual({ ok: false, error: "human_driving" });
	});

	test("state returns to agent once the ttl has elapsed", () => {
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		expect(lock.state()).toBe("human-active");

		// Just before the ttl boundary it is still human-active.
		fake.advance(2999);
		expect(lock.state()).toBe("human-active");

		// At exactly ttl, the window has elapsed -> back to agent.
		fake.advance(1);
		expect(lock.state()).toBe("agent");
		expect(lock.tryAgentWrite()).toEqual({ ok: true });
	});

	test("default ttl is 3000ms", () => {
		const lock = new WriteLock({ clock: fake.clock });
		lock.noteHumanActivity();
		fake.advance(2999);
		expect(lock.state()).toBe("human-active");
		fake.advance(1);
		expect(lock.state()).toBe("agent");
	});

	test("tryAgentWrite never throws and reports human_driving while human active", () => {
		const lock = new WriteLock({ clock: fake.clock });
		lock.noteHumanActivity();
		let result: ReturnType<WriteLock["tryAgentWrite"]> | undefined;
		expect(() => {
			result = lock.tryAgentWrite();
		}).not.toThrow();
		expect(result).toEqual({ ok: false, error: "human_driving" });
	});

	describe("justTookOver", () => {
		test("is false before any human activity", () => {
			const lock = new WriteLock({ clock: fake.clock });
			expect(lock.justTookOver()).toBe(false);
		});

		test("fires exactly once after a fresh agent->human flip", () => {
			const lock = new WriteLock({ clock: fake.clock });
			lock.noteHumanActivity();
			expect(lock.justTookOver()).toBe(true);
			expect(lock.justTookOver()).toBe(false);
			expect(lock.justTookOver()).toBe(false);
		});

		test("does not fire again for continued human activity within the same takeover", () => {
			const lock = new WriteLock({ clock: fake.clock });
			lock.noteHumanActivity();
			expect(lock.justTookOver()).toBe(true);

			// Human keeps typing while still within the active window -> not a new takeover.
			fake.advance(1000);
			lock.noteHumanActivity();
			expect(lock.justTookOver()).toBe(false);
		});

		test("fires again on a new takeover after the lock lapsed back to agent", () => {
			const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });

			lock.noteHumanActivity();
			expect(lock.justTookOver()).toBe(true);
			expect(lock.justTookOver()).toBe(false);

			// Let the lock lapse fully back to agent.
			fake.advance(3000);
			expect(lock.state()).toBe("agent");

			// A brand-new human takeover should announce once more.
			lock.noteHumanActivity();
			expect(lock.justTookOver()).toBe(true);
			expect(lock.justTookOver()).toBe(false);
		});

		test("a takeover detected via state() lapse still announces on the next noteHumanActivity", () => {
			const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });

			lock.noteHumanActivity();
			lock.justTookOver(); // consume the first announcement

			fake.advance(3000); // lapse to agent
			expect(lock.state()).toBe("agent");

			lock.noteHumanActivity(); // fresh flip
			expect(lock.justTookOver()).toBe(true);
		});

		test("re-activity while still human-active never re-announces (regression on the flag reset)", () => {
			const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
			lock.noteHumanActivity();
			lock.justTookOver(); // consumed

			// Several pokes within the window; each refreshes the deadline but is not a flip.
			for (let i = 0; i < 5; i++) {
				fake.advance(500);
				lock.noteHumanActivity();
				expect(lock.state()).toBe("human-active");
				expect(lock.justTookOver()).toBe(false);
			}
		});
	});

	test("default clock (Date.now) works without injection", () => {
		const lock = new WriteLock();
		expect(lock.state()).toBe("agent");
		expect(lock.tryAgentWrite()).toEqual({ ok: true });
		lock.noteHumanActivity();
		expect(lock.state()).toBe("human-active");
		expect(lock.justTookOver()).toBe(true);
		expect(lock.justTookOver()).toBe(false);
	});
});
