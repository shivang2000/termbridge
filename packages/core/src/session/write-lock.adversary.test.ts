import { describe, expect, test } from "bun:test";
import type { Clock } from "../types.js";
import { WriteLock } from "./write-lock.js";

/** A controllable fake clock that can also jump backwards (adversarial). */
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

describe("WriteLock — adversarial", () => {
	test("exactly ttlMs elapsed is NOT human-active (strict less-than boundary)", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		fake.set(3000); // delta === ttlMs
		expect(lock.state()).toBe("agent");
		expect(lock.tryAgentWrite()).toEqual({ ok: true });
	});

	test("ttlMs - 1 elapsed is still human-active (boundary minus one)", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		fake.set(2999);
		expect(lock.state()).toBe("human-active");
		expect(lock.tryAgentWrite()).toEqual({ ok: false, error: "human_driving" });
	});

	test("boundary works with a non-zero clock origin", () => {
		const fake = makeClock(1_000_000);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 50 });
		lock.noteHumanActivity();
		fake.advance(49);
		expect(lock.state()).toBe("human-active");
		fake.advance(1);
		expect(lock.state()).toBe("agent");
	});

	test("ttlMs=0 means the lock is never human-active (state is the single source of truth)", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 0 });
		lock.noteHumanActivity();
		expect(lock.state()).toBe("agent");
		expect(lock.tryAgentWrite()).toEqual({ ok: true });
		expect(lock.justTookOver()).toBe(false);
	});

	test("negative ttlMs degrades to always-agent without throwing", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: -100 });
		expect(() => lock.noteHumanActivity()).not.toThrow();
		expect(lock.state()).toBe("agent");
		expect(lock.justTookOver()).toBe(false);
	});

	test("very large ttlMs keeps human active across long spans", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: Number.MAX_SAFE_INTEGER });
		lock.noteHumanActivity();
		fake.advance(1_000_000_000);
		expect(lock.state()).toBe("human-active");
	});

	test("initial state is agent even at a huge clock value (Infinity arithmetic is safe)", () => {
		const fake = makeClock(Number.MAX_SAFE_INTEGER);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		expect(lock.state()).toBe("agent");
		expect(lock.justTookOver()).toBe(false);
	});

	test("justTookOver before any activity never throws and stays false across repeated calls", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock });
		for (let i = 0; i < 100; i++) {
			expect(lock.justTookOver()).toBe(false);
		}
	});

	test("clock jumping backwards keeps the lock human-active and never throws", () => {
		const fake = makeClock(1000);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		fake.set(0); // regression: delta becomes negative, still < ttl
		expect(() => lock.state()).not.toThrow();
		expect(lock.state()).toBe("human-active");
	});

	test("clock jumping far forward then back is still consistent with state()", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		fake.set(10_000); // lapse to agent
		expect(lock.state()).toBe("agent");
		fake.set(0); // jump back before the stamp; delta negative -> human-active again
		expect(lock.state()).toBe("human-active");
		expect(lock.justTookOver()).toBe(true);
		expect(lock.justTookOver()).toBe(false);
	});

	test("flip without consuming, lapse, flip again: a single announcement is still owed", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity(); // flip 1 arms announcement
		fake.advance(3000); // lapse to agent
		expect(lock.state()).toBe("agent");
		lock.noteHumanActivity(); // flip 2 (still armed)
		expect(lock.justTookOver()).toBe(true);
		expect(lock.justTookOver()).toBe(false);
	});

	test("justTookOver returns false once the window lapses even if never consumed", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity(); // armed, not consumed
		fake.advance(3000); // lapse
		expect(lock.justTookOver()).toBe(false);
	});

	test("many takeovers each announce exactly once", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 1000 });
		let announcements = 0;
		for (let i = 0; i < 50; i++) {
			lock.noteHumanActivity();
			if (lock.justTookOver()) announcements++;
			expect(lock.justTookOver()).toBe(false);
			fake.advance(1000); // lapse fully back to agent before next takeover
			expect(lock.state()).toBe("agent");
		}
		expect(announcements).toBe(50);
	});

	test("hammering noteHumanActivity within one window yields exactly one announcement", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 5000 });
		let announcements = 0;
		for (let i = 0; i < 1000; i++) {
			fake.advance(1); // stays well within 5000ms window
			lock.noteHumanActivity();
			if (lock.justTookOver()) announcements++;
		}
		expect(announcements).toBe(1);
	});

	test("noteHumanActivity exactly at the lapse boundary re-arms (fresh flip)", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		expect(lock.justTookOver()).toBe(true);
		fake.set(3000);
		expect(lock.state()).toBe("agent");
		lock.noteHumanActivity();
		expect(lock.justTookOver()).toBe(true);
	});

	test("noteHumanActivity one tick before lapse does NOT re-arm (still same takeover)", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		expect(lock.justTookOver()).toBe(true);
		fake.set(2999); // still human-active
		expect(lock.state()).toBe("human-active");
		lock.noteHumanActivity(); // refresh, not a flip
		expect(lock.justTookOver()).toBe(false);
	});

	test("tryAgentWrite does not consume a pending takeover announcement", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		for (let i = 0; i < 10; i++) {
			expect(lock.tryAgentWrite()).toEqual({ ok: false, error: "human_driving" });
		}
		expect(lock.justTookOver()).toBe(true);
		expect(lock.justTookOver()).toBe(false);
	});

	test("state() is idempotent and side-effect free", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		for (let i = 0; i < 10; i++) expect(lock.state()).toBe("human-active");
		expect(lock.justTookOver()).toBe(true);
	});

	test("fractional clock values respect the strict boundary", () => {
		const fake = makeClock(0.0);
		const lock = new WriteLock({ clock: fake.clock, ttlMs: 3000 });
		lock.noteHumanActivity();
		fake.set(2999.9999);
		expect(lock.state()).toBe("human-active");
		fake.set(3000.0001);
		expect(lock.state()).toBe("agent");
	});

	test("default ttl (no ttlMs) is exactly 3000ms with injected clock", () => {
		const fake = makeClock(0);
		const lock = new WriteLock({ clock: fake.clock });
		lock.noteHumanActivity();
		fake.set(2999);
		expect(lock.state()).toBe("human-active");
		fake.set(3000);
		expect(lock.state()).toBe("agent");
	});

	test("empty options object behaves identically to no options", () => {
		const fake = makeClock(0);
		const a = new WriteLock({});
		const b = new WriteLock();
		expect(a.state()).toBe("agent");
		expect(b.state()).toBe("agent");
		a.noteHumanActivity();
		b.noteHumanActivity();
		expect(a.state()).toBe("human-active");
		expect(b.state()).toBe("human-active");
		void fake;
	});
});
