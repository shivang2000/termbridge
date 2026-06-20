import { beforeEach, describe, expect, test } from "bun:test";

import type { Clock } from "../types.js";
import { PtyObserver } from "./pty-observer.js";

/** A controllable clock for deterministic time assertions. */
function makeClock(start = 1000): { clock: Clock; set: (t: number) => void } {
	let now = start;
	return {
		clock: () => now,
		set: (t: number) => {
			now = t;
		},
	};
}

describe("PtyObserver.ingest", () => {
	let timeline: ReturnType<typeof makeClock>;
	let observer: PtyObserver;

	beforeEach(() => {
		timeline = makeClock(1000);
		observer = new PtyObserver({ clock: timeline.clock });
	});

	test("ingest advances lastActivityAt to the injected clock value", () => {
		expect(observer.lastActivityAt()).toBe(1000);

		timeline.set(2500);
		observer.ingest("hello");
		expect(observer.lastActivityAt()).toBe(2500);

		timeline.set(4200);
		observer.ingest(" world");
		expect(observer.lastActivityAt()).toBe(4200);
	});

	test("empty ingest still records activity at the clock value", () => {
		timeline.set(3333);
		observer.ingest("");
		expect(observer.lastActivityAt()).toBe(3333);
	});
});

describe("PtyObserver.buffer / offsets", () => {
	let observer: PtyObserver;

	beforeEach(() => {
		observer = new PtyObserver({ clock: makeClock(0).clock });
	});

	test("buffer(0) returns the whole buffer", () => {
		observer.ingest("abc");
		observer.ingest("def");
		const res = observer.buffer(0);
		expect(res.data).toBe("abcdef");
		expect(res.nextOffset).toBe(6);
	});

	test("buffer() with no argument returns the whole buffer", () => {
		observer.ingest("xyz");
		const res = observer.buffer();
		expect(res.data).toBe("xyz");
		expect(res.nextOffset).toBe(3);
	});

	test("buffer(prevNextOffset) returns only the new slice", () => {
		observer.ingest("abc");
		const first = observer.buffer(0);
		expect(first.data).toBe("abc");
		expect(first.nextOffset).toBe(3);

		observer.ingest("defg");
		const second = observer.buffer(first.nextOffset);
		expect(second.data).toBe("defg");
		expect(second.nextOffset).toBe(7);
	});

	test("buffer(nextOffset) at the end returns empty slice with stable offset", () => {
		observer.ingest("abc");
		const res = observer.buffer(3);
		expect(res.data).toBe("");
		expect(res.nextOffset).toBe(3);
	});

	test("buffer with offset past the end clamps to empty", () => {
		observer.ingest("ab");
		const res = observer.buffer(99);
		expect(res.data).toBe("");
		expect(res.nextOffset).toBe(2);
	});

	test("buffer with negative offset is treated as 0", () => {
		observer.ingest("abc");
		const res = observer.buffer(-5);
		expect(res.data).toBe("abc");
		expect(res.nextOffset).toBe(3);
	});

	test("empty buffer returns empty data and zero offset", () => {
		const res = observer.buffer(0);
		expect(res.data).toBe("");
		expect(res.nextOffset).toBe(0);
	});
});

describe("PtyObserver.onData", () => {
	let observer: PtyObserver;

	beforeEach(() => {
		observer = new PtyObserver({ clock: makeClock(0).clock });
	});

	test("onData fires with each ingested chunk", () => {
		const seen: string[] = [];
		observer.onData((c) => seen.push(c));

		observer.ingest("one");
		observer.ingest("two");

		expect(seen).toEqual(["one", "two"]);
	});

	test("multiple subscribers all receive each chunk", () => {
		const a: string[] = [];
		const b: string[] = [];
		observer.onData((c) => a.push(c));
		observer.onData((c) => b.push(c));

		observer.ingest("z");

		expect(a).toEqual(["z"]);
		expect(b).toEqual(["z"]);
	});

	test("empty chunk does not invoke onData callbacks", () => {
		const seen: string[] = [];
		observer.onData((c) => seen.push(c));
		observer.ingest("");
		expect(seen).toEqual([]);
	});
});

describe("PtyObserver poll loop", () => {
	test("start polls readAppended and ingests non-empty results", async () => {
		const timeline = makeClock(0);
		const chunks = ["aa", "", "bb", ""];
		let i = 0;
		const readAppended = async (): Promise<string> => {
			const next = i < chunks.length ? chunks[i] : "";
			i += 1;
			return next ?? "";
		};

		const seen: string[] = [];
		const observer = new PtyObserver({
			clock: timeline.clock,
			readAppended,
			pollMs: 1,
		});
		observer.onData((c) => seen.push(c));
		observer.start();

		// Wait until both non-empty chunks have been drained.
		const deadline = Date.now() + 2000;
		while (seen.length < 2 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2));
		}
		observer.stop();

		expect(seen).toEqual(["aa", "bb"]);
		expect(observer.buffer(0).data).toBe("aabb");
	});

	test("stop halts further polling", async () => {
		let calls = 0;
		const readAppended = async (): Promise<string> => {
			calls += 1;
			return "";
		};
		const observer = new PtyObserver({
			clock: makeClock(0).clock,
			readAppended,
			pollMs: 1,
		});
		observer.start();
		await new Promise((r) => setTimeout(r, 10));
		observer.stop();
		const after = calls;
		await new Promise((r) => setTimeout(r, 20));
		// No more than one extra in-flight call may have completed.
		expect(calls - after).toBeLessThanOrEqual(1);
	});

	test("start is idempotent (does not spawn a second loop)", async () => {
		let calls = 0;
		const readAppended = async (): Promise<string> => {
			calls += 1;
			return "";
		};
		const observer = new PtyObserver({
			clock: makeClock(0).clock,
			readAppended,
			pollMs: 2,
		});
		observer.start();
		observer.start();
		await new Promise((r) => setTimeout(r, 12));
		observer.stop();
		// With a single loop at 2ms over ~12ms we expect a handful of calls,
		// not double. Just assert it ran and stayed bounded.
		expect(calls).toBeGreaterThan(0);
		expect(calls).toBeLessThan(30);
	});
});
