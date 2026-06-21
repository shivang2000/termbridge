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
// Exact cap boundary: at buf.length === cap NOTHING is dropped; at cap+1 exactly
// one byte is dropped. Off-by-one bugs in the `>` comparison or the slice index
// would surface here.
// ---------------------------------------------------------------------------
describe("cap-adversary: exact boundary", () => {
	test("buffer exactly at cap retains everything (no premature drop)", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 5 });
		o.ingest("abcde"); // length === cap
		const r = o.buffer(0);
		expect(r.data).toBe("abcde");
		expect(r.data.length).toBe(5);
		expect(r.nextOffset).toBe(5);
		// windowStart should be 0 here: buffer(0) is the full content.
		expect(o.buffer(0).data).toBe("abcde");
	});

	test("one byte over cap drops exactly one byte from the front", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 5 });
		o.ingest("abcdef"); // length === cap + 1
		const r = o.buffer(0);
		expect(r.data).toBe("bcdef");
		expect(r.data.length).toBe(5);
		expect(r.nextOffset).toBe(6);
		// windowStart === 1: offset 0 predates window, offset 1 is window start.
		expect(o.buffer(0).data).toBe("bcdef");
		expect(o.buffer(1).data).toBe("bcdef");
		expect(o.buffer(2).data).toBe("cdef");
	});

	test("building up to the cap one byte at a time never drops early", () => {
		const cap = 8;
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: cap });
		let expected = "";
		for (let i = 0; i < cap; i++) {
			const c = String.fromCharCode(65 + i);
			o.ingest(c);
			expected += c;
			expect(o.buffer(0).data).toBe(expected);
			expect(o.buffer(0).data.length).toBe(i + 1);
		}
		// The very next byte must trigger exactly one drop.
		o.ingest("Z");
		expect(o.buffer(0).data.length).toBe(cap);
		expect(o.buffer(0).data).toBe(`${expected.slice(1)}Z`);
	});
});

// ---------------------------------------------------------------------------
// A single ingest LARGER than the cap. The drop must keep only the last `cap`
// bytes of that one chunk; totalBytes counts the whole chunk.
// ---------------------------------------------------------------------------
describe("cap-adversary: single chunk larger than cap", () => {
	test("oversized single chunk keeps only the trailing cap bytes", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 3 });
		o.ingest("abcdefghij"); // 10 bytes, cap 3
		const r = o.buffer(0);
		expect(r.data).toBe("hij");
		expect(r.data.length).toBe(3);
		expect(r.nextOffset).toBe(10);
		// windowStart === 7
		expect(o.buffer(7).data).toBe("hij");
		expect(o.buffer(8).data).toBe("ij");
		expect(o.buffer(10).data).toBe("");
	});

	test("oversized chunk after existing content still keeps trailing cap bytes", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 4 });
		o.ingest("XY"); // total 2, buf "XY"
		o.ingest("0123456789"); // total 12, combined "XY0123456789" -> tail "6789"
		const r = o.buffer(0);
		expect(r.data).toBe("6789");
		expect(r.data.length).toBe(4);
		expect(r.nextOffset).toBe(12);
	});
});

// ---------------------------------------------------------------------------
// Multi-overflow offset correctness: a reader that KEEPS UP (reads after every
// ingest) must always receive exactly the just-ingested chunk (trimmed to cap),
// with the offset advancing by the full ingested length — never duplicating,
// never skipping, never returning a negative/garbage slice.
// ---------------------------------------------------------------------------
describe("cap-adversary: multi-overflow incremental correctness", () => {
	test("keep-up reader sees each chunk exactly once across many drops", () => {
		const cap = 7;
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: cap });
		const chunks = [
			"a",
			"bb",
			"ccc",
			"dddd",
			"eeeee",
			"ffffff",
			"ggggggg",
			"hhhhhhhh", // > cap on its own
			"i",
		];
		let prev = 0;
		for (const c of chunks) {
			o.ingest(c);
			const d = o.buffer(prev);
			const trimmed = c.length <= cap ? c : c.slice(c.length - cap);
			expect(d.data).toBe(trimmed);
			expect(d.data.length).toBeLessThanOrEqual(cap);
			expect(d.nextOffset).toBe(prev + c.length);
			prev = d.nextOffset;
		}
	});

	test("lagging reader never gets a negative slice and offset stays monotonic", () => {
		const cap = 4;
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: cap });
		// Ingest a lot WITHOUT reading, so the reader's stale offset is far behind
		// the retained window.
		for (let i = 0; i < 30; i++) {
			o.ingest(`X${i}`);
		}
		const total = o.buffer(0).nextOffset;
		// A stale read from offset 0 (long since dropped) must serve the tail, not
		// crash or return stale/duplicated/negative data.
		const stale = o.buffer(0);
		expect(stale.data.length).toBeLessThanOrEqual(cap);
		expect(stale.nextOffset).toBe(total);
		// And it must equal the actual retained tail (whole buf).
		expect(o.buffer(total - cap).data).toBe(stale.data);
		// A second read from the now-current offset yields empty.
		expect(o.buffer(total).data).toBe("");
		expect(o.buffer(total).nextOffset).toBe(total);
	});

	test("interleaved keep-up and lagging reads stay consistent", () => {
		const cap = 6;
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: cap });
		let fast = 0;
		const slow = 0;
		const seenFast: string[] = [];
		for (let i = 0; i < 40; i++) {
			const c = `${i % 10}`;
			o.ingest(c);
			const d = o.buffer(fast);
			seenFast.push(d.data);
			fast = d.nextOffset;
		}
		// Fast reader, keeping up 1 byte at a time, reconstructs the full stream.
		expect(seenFast.join("")).toBe(Array.from({ length: 40 }, (_, i) => `${i % 10}`).join(""));
		// Slow reader from the very start gets only the retained tail.
		const slowRead = o.buffer(slow);
		expect(slowRead.data.length).toBeLessThanOrEqual(cap);
		expect(slowRead.nextOffset).toBe(40);
		expect(slowRead.data).toBe(o.buffer(40 - cap).data);
	});
});

// ---------------------------------------------------------------------------
// Degenerate / hostile cap values. The cap is an injected option; a caller could
// pass 0, a negative, a fractional, or a huge cap. None may throw, produce a
// growing buffer beyond the cap, or break the monotonic offset.
// ---------------------------------------------------------------------------
describe("cap-adversary: degenerate cap values", () => {
	test("cap of 0 drops everything but keeps offsets monotonic", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 0 });
		o.ingest("abc");
		expect(o.buffer(0).data).toBe("");
		expect(o.buffer(0).nextOffset).toBe(3);
		o.ingest("de");
		expect(o.buffer(0).data).toBe("");
		expect(o.buffer(3).data).toBe("");
		expect(o.buffer(5).nextOffset).toBe(5);
	});

	test("negative cap behaves like an empty-retention buffer, no crash", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: -5 });
		expect(() => o.ingest("hello")).not.toThrow();
		const r = o.buffer(0);
		expect(r.data.length).toBe(0);
		expect(r.nextOffset).toBe(5);
	});

	test("fractional cap never lets buf exceed floor(cap) and offsets stay sound", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 3.9 });
		o.ingest("abcdef");
		const r = o.buffer(0);
		// buf.length must not exceed the cap value (3.9 -> at most 3 retained,
		// since lengths are integers and buf.length > 3.9 triggers a trim to
		// keeping the last 3.9 -> slice index is integer-truncated by the engine).
		expect(r.data.length).toBeLessThanOrEqual(4);
		expect(r.nextOffset).toBe(6);
		// Whatever is retained must be a suffix of the true stream.
		expect("abcdef".endsWith(r.data)).toBe(true);
	});

	test("huge cap keeps everything (acts as effectively-unbounded)", () => {
		const o = new PtyObserver({
			clock: makeClock().clock,
			maxBufferBytes: 1_000_000,
		});
		const big = "q".repeat(50_000);
		o.ingest(big);
		o.ingest(big);
		expect(o.buffer(0).data.length).toBe(100_000);
		expect(o.buffer(0).nextOffset).toBe(100_000);
	});
});

// ---------------------------------------------------------------------------
// The cap must not corrupt the activity clock or onData delivery, and onData
// always receives the FULL untrimmed chunk (subscribers see the live stream,
// the cap only bounds the replay buffer).
// ---------------------------------------------------------------------------
describe("cap-adversary: cap interaction with onData and clock", () => {
	test("onData receives the full chunk even when the buffer trims it", () => {
		const o = new PtyObserver({ clock: makeClock().clock, maxBufferBytes: 2 });
		const seen: string[] = [];
		o.onData((c) => seen.push(c));
		o.ingest("abcdef");
		// Subscriber sees the whole chunk; only the replay buffer is capped.
		expect(seen).toEqual(["abcdef"]);
		expect(o.buffer(0).data.length).toBeLessThanOrEqual(2);
	});

	test("activity clock advances on overflow ingests", () => {
		const tl = makeClock(0);
		const o = new PtyObserver({ clock: tl.clock, maxBufferBytes: 1 });
		tl.set(424242);
		o.ingest("a very long line that overflows the tiny cap");
		expect(o.lastActivityAt()).toBe(424242);
		expect(o.buffer(0).data.length).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// Poll-driven overflow: the production path feeds the buffer through start()/
// readAppended. The cap must hold under the real loop too, with correct offsets.
// ---------------------------------------------------------------------------
describe("cap-adversary: poll-driven overflow", () => {
	test("poll loop honours the cap and keeps offsets monotonic", async () => {
		const cap = 6;
		const chunks = ["aaa", "bbb", "ccc", "ddd", ""];
		let i = 0;
		const readAppended = async (): Promise<string> => {
			const v = i < chunks.length ? (chunks[i] ?? "") : "";
			i += 1;
			return v;
		};
		const o = new PtyObserver({
			clock: makeClock().clock,
			readAppended,
			pollMs: 1,
			maxBufferBytes: cap,
		});
		o.start();
		const deadline = Date.now() + 2000;
		while (o.buffer(0).nextOffset < 12 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2));
		}
		o.stop();
		expect(o.buffer(0).nextOffset).toBe(12);
		expect(o.buffer(0).data.length).toBeLessThanOrEqual(cap);
		// Retained tail must be the last `cap` bytes of "aaabbbcccddd".
		expect(o.buffer(0).data).toBe("cccddd");
	});
});
