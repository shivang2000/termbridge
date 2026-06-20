// WS bridge core — wires a termbridge Session to a browser xterm over a
// WebSocket, using ONLY tmux primitives (no PTY). Output streams from the
// PtyObserver (pipe-pane); the initial paint is a capture-pane snapshot; human
// keystrokes go in via send-keys (which flips the WriteLock to human-active).
//
// Decoupled from Hono/Bun so it is unit-testable with a fake Session + fake
// socket. The transport layer (server.ts) owns the actual WebSocket + the poll
// interval; this module owns the protocol.

import type { RecognizedEvent } from "@termbridge/core";

/** The minimal socket the bridge writes to. */
export interface WsLike {
	send(data: string): void;
}

/** The minimal Session surface the bridge needs (satisfied by core's Session). */
export interface BridgeSessionView {
	readScreen(opts: { escapes?: boolean }): Promise<string>;
	sendHumanInput(data: string): Promise<void>;
	resize(cols: number, rows: number): Promise<void>;
	readEvents(opts?: {
		sinceOffset?: number;
	}): Promise<{ events: RecognizedEvent[]; nextOffset: number }>;
	onOutput(cb: (chunk: string) => void): () => void;
}

/** Server→client frames. */
export type ServerFrame =
	| { type: "init"; screen: string }
	| { type: "stdout"; data: string }
	| { type: "event"; events: RecognizedEvent[] }
	| { type: "error"; message: string };

/** Client→server frames. */
export type ClientFrame =
	| { type: "stdin"; data: string }
	| { type: "resize"; cols: number; rows: number };

export interface Bridge {
	/** Paint the current screen and begin streaming live output. */
	start(): Promise<void>;
	/** Handle one raw client frame (JSON). Malformed input is ignored. */
	handleMessage(raw: string): Promise<void>;
	/** Poll recognizer events since the last poll and push any new ones. */
	pollEvents(): Promise<void>;
	/** Stop streaming (unsubscribe). Idempotent. */
	stop(): void;
}

export function createBridge(session: BridgeSessionView, ws: WsLike): Bridge {
	let off: (() => void) | null = null;
	let eventOffset = 0;
	let stopped = false;

	return {
		async start() {
			const screen = await session.readScreen({ escapes: true });
			ws.send(JSON.stringify({ type: "init", screen } satisfies ServerFrame));
			off = session.onOutput((data) => {
				if (!stopped) {
					ws.send(JSON.stringify({ type: "stdout", data } satisfies ServerFrame));
				}
			});
		},

		async handleMessage(raw: string) {
			let msg: ClientFrame;
			try {
				msg = JSON.parse(raw) as ClientFrame;
			} catch {
				return;
			}
			if (msg.type === "stdin" && typeof msg.data === "string") {
				await session.sendHumanInput(msg.data);
			} else if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
				await session.resize(msg.cols, msg.rows);
			}
		},

		async pollEvents() {
			const { events, nextOffset } = await session.readEvents({ sinceOffset: eventOffset });
			eventOffset = nextOffset;
			if (events.length > 0 && !stopped) {
				ws.send(JSON.stringify({ type: "event", events } satisfies ServerFrame));
			}
		},

		stop() {
			stopped = true;
			off?.();
			off = null;
		},
	};
}
