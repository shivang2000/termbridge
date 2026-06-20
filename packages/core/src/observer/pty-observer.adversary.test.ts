import { describe, expect, test } from "bun:test";

import type { Clock } from "../types.js";
import { PtyObserver } from "./pty-observer.js";

function makeClock(start = 0): { clock: Clock; set: (t: number) => void } {
	let now = start;
	return {
		clock: () => now,
		set: (t: number) => {
			now = t;
		},
	};
}

// ---------------------------------------------------------------------------
// Offset round-trip invariant: incremental reads must reconstruct the full
// buffer exactly, regardless of chunking — including across pathological splits.
// ---------------------------------------------------------------------------
describe("adversary: offset round-trip invariant", () => {
	test("incremental reads stitched together equal buffer(0) for arbitrary chunks", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const chunks = ["", "a", "", "bcd", "e", "", "fghij", "k"];
		for (const c of chunks) obs.ingest(c);

		let offset = 0;
		let stitched = "";
		// Drain in 1-byte windows to stress every boundary.
		const full = obs.buffer(0).data;
		for (let i = 0; i < full.length; i += 1) {
			// Re-read whole buffer each step is wrong; instead read from offset.
			const res = obs.buffer(offset);
			// Take only one code unit to stress incremental stitching.
			stitched += res.data.slice(0, 1);
			offset += 1;
		}
		expect(stitched).toBe(full);
		expect(obs.buffer(offset).data).toBe("");
		expect(obs.buffer(offset).nextOffset).toBe(full.length);
	});

	test("repeated buffer(nextOffset) after each ingest never drops or duplicates", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		let offset = 0;
		let assembled = "";
		for (const c of ["one", "two", "three", "", "four"]) {
			obs.ingest(c);
			const res = obs.buffer(offset);
			assembled += res.data;
			offset = res.nextOffset;
		}
		expect(assembled).toBe("onetwothreefour");
		expect(offset).toBe("onetwothreefour".length);
	});
});

// ---------------------------------------------------------------------------
// Unicode / surrogate pairs / control chars / ANSI noise.
// length is measured in UTF-16 code units; buffer and totalBytes must agree.
// ---------------------------------------------------------------------------
describe("adversary: unicode and control-char noise", () => {
	test("buffer/totalBytes stay consistent with astral (surrogate-pair) chars", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		obs.ingest("😀"); // 2 UTF-16 code units
		const res = obs.buffer(0);
		expect(res.data).toBe("😀");
		expect(res.nextOffset).toBe(2);
		// Reading from the surrogate-pair boundary yields the second half — the
		// contract is code-unit based, so this is the documented behavior.
		const mid = obs.buffer(1);
		expect(mid.data.length).toBe(1);
		expect(mid.nextOffset).toBe(2);
	});

	test("ANSI escape sequences and control chars pass through verbatim", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const noise = "\x1b[31mred\x1b[0m\r\n\x07\x08\t\x00null";
		obs.ingest(noise);
		expect(obs.buffer(0).data).toBe(noise);
		expect(obs.buffer(0).nextOffset).toBe(noise.length);
	});

	test("onData receives chunks verbatim including NUL and ANSI", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const seen: string[] = [];
		obs.onData((c) => seen.push(c));
		obs.ingest("\x1b[2J\x00\u{1F600}");
		expect(seen).toEqual(["\x1b[2J\x00\u{1F600}"]);
	});

	test("combining marks and ZWJ emoji sequences are preserved length-wise", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const family = "👨‍👩‍👧"; // ZWJ sequence
		obs.ingest(family);
		expect(obs.buffer(0).data).toBe(family);
		expect(obs.buffer(0).nextOffset).toBe(family.length);
	});
});

// ---------------------------------------------------------------------------
// Very long input.
// ---------------------------------------------------------------------------
describe("adversary: very long input", () => {
	test("large single ingest and large many-chunk ingest agree on offsets", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const big = "x".repeat(500_000);
		obs.ingest(big);
		expect(obs.buffer(0).nextOffset).toBe(500_000);
		expect(obs.buffer(499_999).data).toBe("x");

		const obs2 = new PtyObserver({ clock: makeClock().clock });
		let total = 0;
		for (let i = 0; i < 1000; i += 1) {
			obs2.ingest("y".repeat(100));
			total += 100;
		}
		expect(obs2.buffer(0).nextOffset).toBe(total);
		expect(obs2.buffer(total).data).toBe("");
	});
});

// ---------------------------------------------------------------------------
// onData callback hazards: throwing callbacks, re-entrant subscription.
// A misbehaving subscriber must not corrupt buffer state or silently swallow
// data for OTHER subscribers / future ingests.
// ---------------------------------------------------------------------------
describe("adversary: onData callback hazards", () => {
	test("a throwing callback is isolated: ingest does not throw and buffer is intact", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		obs.onData(() => {
			throw new Error("subscriber blew up");
		});
		// Contract: a faulty subscriber must not crash the observer's data flow
		// (in production this is the pipe-pane loop). ingest must not throw.
		expect(() => obs.ingest("abc")).not.toThrow();
		// Buffer must reflect the ingest regardless of the faulty subscriber.
		expect(obs.buffer(0).data).toBe("abc");
		expect(obs.buffer(0).nextOffset).toBe(3);
		// A subsequent good ingest must still work.
		expect(() => obs.ingest("def")).not.toThrow();
		expect(obs.buffer(0).data).toBe("abcdef");
	});

	test("a throwing subscriber does not block later subscribers (isolation)", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const good: string[] = [];
		obs.onData(() => {
			throw new Error("boom");
		});
		obs.onData((c) => good.push(c));
		// The contract: every subscriber sees each chunk; a faulty one must not
		// starve the others, and ingest must not throw.
		expect(() => obs.ingest("hello")).not.toThrow();
		expect(good).toEqual(["hello"]);
	});

	test("subscribing from within a callback does not re-deliver the in-flight chunk", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		const lateSeen: string[] = [];
		obs.onData(() => {
			obs.onData((c) => lateSeen.push(c));
		});
		obs.ingest("first");
		// The late subscriber must NOT have received "first" (it subscribed
		// during the same delivery). It should only see subsequent chunks.
		expect(lateSeen).toEqual([]);
		obs.ingest("second");
		expect(lateSeen).toEqual(["second"]);
	});
});

// ---------------------------------------------------------------------------
// lastActivity semantics under empty/garbage input.
// ---------------------------------------------------------------------------
describe("adversary: activity clock edge cases", () => {
	test("empty ingest advances activity (idle detection must see the read)", () => {
		const tl = makeClock(100);
		const obs = new PtyObserver({ clock: tl.clock });
		expect(obs.lastActivityAt()).toBe(100);
		tl.set(250);
		obs.ingest("");
		expect(obs.lastActivityAt()).toBe(250);
	});

	test("lastActivity uses clock value at ingest time, not construction", () => {
		const tl = makeClock(5);
		const obs = new PtyObserver({ clock: tl.clock });
		tl.set(9999);
		obs.ingest("data");
		expect(obs.lastActivityAt()).toBe(9999);
	});

	test("clock that goes backwards is reflected verbatim (no monotonic clamp)", () => {
		const tl = makeClock(1000);
		const obs = new PtyObserver({ clock: tl.clock });
		obs.ingest("a");
		expect(obs.lastActivityAt()).toBe(1000);
		tl.set(500);
		obs.ingest("b");
		// Documents that the observer trusts the injected clock as-is.
		expect(obs.lastActivityAt()).toBe(500);
	});
});

// ---------------------------------------------------------------------------
// Poll loop adversarial: no readAppended, rejecting reads, reentrancy guard
// with slow reads, stop()/start() lifecycle.
// ---------------------------------------------------------------------------
describe("adversary: poll loop robustness", () => {
	test("start() is a no-op when no readAppended source is provided", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		// Should not throw and should not need stop().
		expect(() => obs.start()).not.toThrow();
		expect(() => obs.stop()).not.toThrow();
	});

	test("stop() before start() is safe", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		expect(() => obs.stop()).not.toThrow();
	});

	test("reentrancy guard prevents overlapping reads when read is slow", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		let completed = 0;
		const readAppended = async (): Promise<string> => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((r) => setTimeout(r, 8));
			concurrent -= 1;
			completed += 1;
			return "";
		};
		const obs = new PtyObserver({
			clock: makeClock().clock,
			readAppended,
			pollMs: 1, // much faster than the 8ms read
		});
		obs.start();
		await new Promise((r) => setTimeout(r, 60));
		obs.stop();
		// The guard must ensure reads never overlap despite the fast poll tick.
		expect(maxConcurrent).toBe(1);
		expect(completed).toBeGreaterThan(0);
	});

	test("a rejecting readAppended unsticks the polling guard for later ticks", async () => {
		let calls = 0;
		const readAppended = async (): Promise<string> => {
			calls += 1;
			if (calls <= 2) {
				throw new Error("read failed");
			}
			return "ok";
		};
		const seen: string[] = [];
		const obs = new PtyObserver({
			clock: makeClock().clock,
			readAppended,
			pollMs: 2,
		});
		obs.onData((c) => seen.push(c));
		obs.start();
		const deadline = Date.now() + 1000;
		while (seen.length < 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5));
		}
		obs.stop();
		// Despite the first two reads rejecting, the guard must have been
		// released (finally block) so a later read could succeed and ingest.
		expect(seen).toContain("ok");
		expect(calls).toBeGreaterThanOrEqual(3);
	});

	test("start after stop resumes polling (lifecycle is reusable)", async () => {
		let calls = 0;
		const readAppended = async (): Promise<string> => {
			calls += 1;
			return "";
		};
		const obs = new PtyObserver({
			clock: makeClock().clock,
			readAppended,
			pollMs: 1,
		});
		obs.start();
		await new Promise((r) => setTimeout(r, 10));
		obs.stop();
		const afterFirst = calls;
		expect(afterFirst).toBeGreaterThan(0);
		// Restart.
		obs.start();
		await new Promise((r) => setTimeout(r, 10));
		obs.stop();
		expect(calls).toBeGreaterThan(afterFirst);
	});

	test("buffer() reflects poll-driven ingests with correct incremental offsets", async () => {
		const chunks = ["alpha", "", "beta", "gamma", ""];
		let i = 0;
		const readAppended = async (): Promise<string> => {
			const v = i < chunks.length ? (chunks[i] ?? "") : "";
			i += 1;
			return v;
		};
		const obs = new PtyObserver({
			clock: makeClock().clock,
			readAppended,
			pollMs: 1,
		});
		const deadline = Date.now() + 2000;
		obs.start();
		while (obs.buffer(0).data.length < "alphabetagamma".length && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2));
		}
		obs.stop();
		expect(obs.buffer(0).data).toBe("alphabetagamma");
		expect(obs.buffer(0).nextOffset).toBe("alphabetagamma".length);
	});
});

// ---------------------------------------------------------------------------
// Fractional / non-integer offsets (garbage input to buffer()).
// ---------------------------------------------------------------------------
describe("adversary: garbage offsets to buffer()", () => {
	test("fractional offset behaves like slice (no crash)", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		obs.ingest("abcdef");
		const res = obs.buffer(2.7);
		// String.slice truncates fractional start toward zero -> 2.
		expect(res.data).toBe("cdef");
		expect(res.nextOffset).toBe(6);
	});

	test("NaN offset does not throw and returns a defined result", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		obs.ingest("abc");
		const res = obs.buffer(Number.NaN);
		// NaN < 0 is false and NaN > total is false, so `from` stays NaN;
		// "abc".slice(NaN) === "abc". Document the resilience.
		expect(typeof res.data).toBe("string");
		expect(res.nextOffset).toBe(3);
		expect(res.data).toBe("abc");
	});

	test("Infinity offset clamps to end -> empty", () => {
		const obs = new PtyObserver({ clock: makeClock().clock });
		obs.ingest("abc");
		const res = obs.buffer(Number.POSITIVE_INFINITY);
		expect(res.data).toBe("");
		expect(res.nextOffset).toBe(3);
	});
});
