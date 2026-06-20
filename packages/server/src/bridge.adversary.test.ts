// Adversarial probes of the WS bridge protocol (createBridge). Goal: TRY TO
// BREAK the event-offset bookkeeping, the stop()/idempotency contract, and the
// frame-parsing guards. These exercise edge cases the happy-path bridge.test.ts
// does not: many polls, double-stop, binary-shaped frames, hostile JSON, and
// non-finite / partial resize frames.

import { describe, expect, test } from "bun:test";
import type { RecognizedEvent } from "@termbridge/core";
import { type BridgeSessionView, createBridge, type WsLike } from "./bridge.js";

function fakeWs() {
	const sent: string[] = [];
	const ws: WsLike = { send: (d) => sent.push(d) };
	return { ws, frames: () => sent.map((s) => JSON.parse(s) as Record<string, unknown>) };
}

function fakeSession(over: Partial<BridgeSessionView> = {}) {
	const calls = { humanInput: [] as string[], resize: [] as Array<[number, number]> };
	let outCb: ((c: string) => void) | null = null;
	const session: BridgeSessionView = {
		readScreen: async () => "SCREEN-NOW",
		sendHumanInput: async (d) => {
			calls.humanInput.push(d);
		},
		resize: async (c, r) => {
			calls.resize.push([c, r]);
		},
		readEvents: async () => ({ events: [], nextOffset: 0 }),
		onOutput: (cb) => {
			outCb = cb;
			return () => {
				outCb = null;
			};
		},
		...over,
	};
	return { session, calls, emit: (c: string) => outCb?.(c), subscribed: () => outCb !== null };
}

describe("bridge — event offset bookkeeping (adversarial)", () => {
	test("each poll requests sinceOffset = previous nextOffset; never re-reads the same window", async () => {
		const { ws, frames } = fakeWs();
		// Each poll yields a fresh event at a strictly advancing offset.
		const offsetsRequested: Array<number | undefined> = [];
		let n = 0;
		const fs = fakeSession({
			readEvents: async (o) => {
				offsetsRequested.push(o?.sinceOffset);
				n += 1;
				return {
					events: [{ kind: `e${n}`, data: {}, suggestedKeys: [] } as RecognizedEvent],
					nextOffset: n * 7,
				};
			},
		});
		const bridge = createBridge(fs.session, ws);
		await bridge.pollEvents();
		await bridge.pollEvents();
		await bridge.pollEvents();

		// First poll starts at 0; subsequent polls use the advanced offsets.
		expect(offsetsRequested).toEqual([0, 7, 14]);

		// Every emitted event frame is distinct — the offset advance means the
		// bridge never asks for an already-consumed byte range twice.
		const eventFrames = frames().filter((f) => f.type === "event");
		expect(eventFrames).toHaveLength(3);
		const kinds = eventFrames.flatMap((f) => (f.events as RecognizedEvent[]).map((e) => e.kind));
		expect(kinds).toEqual(["e1", "e2", "e3"]);
		expect(new Set(kinds).size).toBe(3); // no duplicate event delivered
	});

	test("offset still advances even when a poll returns zero events (no stuck offset)", async () => {
		const { ws, frames } = fakeWs();
		const requested: Array<number | undefined> = [];
		const batches: Array<{ events: RecognizedEvent[]; nextOffset: number }> = [
			{ events: [], nextOffset: 100 }, // quiet poll but bytes advanced
			{ events: [{ kind: "late", data: {}, suggestedKeys: [] }], nextOffset: 250 },
		];
		let i = 0;
		const fs = fakeSession({
			readEvents: async (o) => {
				requested.push(o?.sinceOffset);
				return batches[i++] ?? { events: [], nextOffset: 250 };
			},
		});
		const bridge = createBridge(fs.session, ws);
		await bridge.pollEvents();
		await bridge.pollEvents();
		// The empty first poll must STILL advance the offset to 100, so the second
		// poll reads from 100, not 0 (no re-scan of already-seen bytes).
		expect(requested).toEqual([0, 100]);
		expect(frames().filter((f) => f.type === "event")).toHaveLength(1);
	});

	test("a poll after stop() is silent even if readEvents returns events", async () => {
		const { ws, frames } = fakeWs();
		const fs = fakeSession({
			readEvents: async () => ({
				events: [{ kind: "x", data: {}, suggestedKeys: [] }],
				nextOffset: 5,
			}),
		});
		const bridge = createBridge(fs.session, ws);
		bridge.stop();
		await bridge.pollEvents();
		expect(frames().filter((f) => f.type === "event")).toHaveLength(0);
	});
});

describe("bridge — stop() idempotency & output silencing (adversarial)", () => {
	test("stop() is idempotent: calling it repeatedly does not throw and unsubscribe runs once", async () => {
		const { ws } = fakeWs();
		let unsubCount = 0;
		let outCb: ((c: string) => void) | null = null;
		const fs = fakeSession({
			onOutput: (cb) => {
				outCb = cb;
				return () => {
					unsubCount += 1;
					outCb = null;
				};
			},
		});
		const bridge = createBridge(fs.session, ws);
		await bridge.start();
		bridge.stop();
		bridge.stop();
		bridge.stop();
		expect(unsubCount).toBe(1); // off?.() nulled after first call → not re-invoked
		expect(outCb).toBeNull();
	});

	test("output that races in AFTER stop() (subscriber not yet detached) is dropped", async () => {
		// Simulate an observer whose unsubscribe is a no-op (e.g. a chunk already
		// in flight): the bridge's `stopped` flag must still gate the send.
		const { ws, frames } = fakeWs();
		const cbBox: { fn: ((c: string) => void) | null } = { fn: null };
		const fs = fakeSession({
			onOutput: (cb) => {
				cbBox.fn = cb;
				return () => {
					/* deliberately does NOT detach */
				};
			},
		});
		const bridge = createBridge(fs.session, ws);
		await bridge.start();
		bridge.stop();
		cbBox.fn?.("leaked-bytes"); // subscriber still wired, but bridge is stopped
		expect(frames().some((f) => f.data === "leaked-bytes")).toBe(false);
	});

	test("stop() before start() does not throw and start() still works afterwards is NOT required — stop-first is a no-op", () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		expect(() => bridge.stop()).not.toThrow(); // off is null → optional-chained
	});
});

describe("bridge — hostile client frames (adversarial)", () => {
	test("JSON that parses to a non-object primitive is ignored (incl. null & arrays)", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		// REGRESSION GUARD: `JSON.parse("null")` is `null`, whose typeof is "object";
		// a naive `msg.type` access threw `TypeError: null is not an object`, which
		// in server.ts (uncaught onMessage) becomes an unhandled WS rejection.
		await expect(bridge.handleMessage("null")).resolves.toBeUndefined();
		await bridge.handleMessage("42");
		await bridge.handleMessage('"a string"');
		await bridge.handleMessage("true");
		await bridge.handleMessage("[1,2,3]"); // arrays carry no frame either
		expect(fs.calls.humanInput).toEqual([]);
		expect(fs.calls.resize).toEqual([]);
	});

	test("empty string frame is ignored (not valid JSON)", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage("");
		expect(fs.calls.humanInput).toEqual([]);
	});

	test("binary-shaped frame (raw control bytes, not JSON) is ignored", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		// What server.ts would hand us after decoding an ArrayBuffer of raw bytes.
		await bridge.handleMessage("\x00\x01\x02\xff");
		expect(fs.calls.humanInput).toEqual([]);
		expect(fs.calls.resize).toEqual([]);
	});

	test("stdin frame with non-string data is ignored (no humanInput)", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage(JSON.stringify({ type: "stdin", data: 123 }));
		await bridge.handleMessage(JSON.stringify({ type: "stdin", data: null }));
		await bridge.handleMessage(JSON.stringify({ type: "stdin" })); // missing data
		expect(fs.calls.humanInput).toEqual([]);
	});

	test("empty-string stdin data is forwarded verbatim (a real keystroke can be empty-ish)", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage(JSON.stringify({ type: "stdin", data: "" }));
		expect(fs.calls.humanInput).toEqual([""]);
	});

	test("resize with non-finite dims (NaN/Infinity/-Infinity/missing) is ignored", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage(JSON.stringify({ type: "resize", cols: Number.NaN, rows: 40 }));
		await bridge.handleMessage(JSON.stringify({ type: "resize", cols: 120, rows: Number.NaN }));
		// JSON cannot carry Infinity; it serializes to null → also non-finite.
		await bridge.handleMessage('{"type":"resize","cols":null,"rows":40}');
		await bridge.handleMessage('{"type":"resize","cols":120}'); // rows missing → undefined
		await bridge.handleMessage(JSON.stringify({ type: "resize", cols: "120", rows: "40" })); // strings
		expect(fs.calls.resize).toEqual([]);
	});

	test("finite resize dims pass through (regression guard for the finite branch)", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
		expect(fs.calls.resize).toEqual([[80, 24]]);
	});

	test("a sendHumanInput rejection propagates from handleMessage (caller must guard)", async () => {
		// Documents the actual contract: handleMessage awaits sendHumanInput and does
		// NOT swallow its rejection. server.ts onMessage must therefore tolerate it.
		const { ws } = fakeWs();
		const fs = fakeSession({
			sendHumanInput: async () => {
				throw new Error("tmux dead");
			},
		});
		const bridge = createBridge(fs.session, ws);
		await expect(
			bridge.handleMessage(JSON.stringify({ type: "stdin", data: "x" })),
		).rejects.toThrow("tmux dead");
	});
});
