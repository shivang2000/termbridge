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

describe("createBridge", () => {
	test("start paints the screen then streams live output", async () => {
		const { ws, frames } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.start();
		expect(frames()[0]).toEqual({ type: "init", screen: "SCREEN-NOW" });
		fs.emit("live-bytes");
		expect(frames()[1]).toEqual({ type: "stdout", data: "live-bytes" });
	});

	test("stdin frame goes to sendHumanInput (raw bytes)", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage(JSON.stringify({ type: "stdin", data: "\x1b[A" }));
		expect(fs.calls.humanInput).toEqual(["\x1b[A"]);
	});

	test("resize frame goes to session.resize", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
		expect(fs.calls.resize).toEqual([[120, 40]]);
	});

	test("malformed / unknown / non-finite frames are ignored", async () => {
		const { ws } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.handleMessage("not json");
		await bridge.handleMessage(JSON.stringify({ type: "nope" }));
		await bridge.handleMessage(JSON.stringify({ type: "resize", cols: Number.NaN, rows: 1 }));
		expect(fs.calls.humanInput).toEqual([]);
		expect(fs.calls.resize).toEqual([]);
	});

	test("pollEvents pushes only new events and advances the offset", async () => {
		const { ws, frames } = fakeWs();
		const batches: Array<{ events: RecognizedEvent[]; nextOffset: number }> = [
			{ events: [{ kind: "needs_login", data: {}, suggestedKeys: [] }], nextOffset: 10 },
			{ events: [], nextOffset: 10 },
		];
		let i = 0;
		const offsets: Array<number | undefined> = [];
		const fs = fakeSession({
			readEvents: async (o) => {
				offsets.push(o?.sinceOffset);
				return batches[i++] ?? { events: [], nextOffset: 10 };
			},
		});
		const bridge = createBridge(fs.session, ws);
		await bridge.pollEvents();
		await bridge.pollEvents();
		expect(frames().filter((f) => f.type === "event")).toHaveLength(1);
		expect(offsets).toEqual([0, 10]); // second poll uses the advanced offset
	});

	test("stop unsubscribes — no further stdout", async () => {
		const { ws, frames } = fakeWs();
		const fs = fakeSession();
		const bridge = createBridge(fs.session, ws);
		await bridge.start();
		bridge.stop();
		expect(fs.subscribed()).toBe(false);
		fs.emit("after-stop");
		expect(frames().some((f) => f.data === "after-stop")).toBe(false);
	});
});
