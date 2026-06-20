// Unified termbridge server (Bun + Hono). Owns ONE SessionManager and exposes:
//   • POST /api/tool/:name — the §6 tool surface over HTTP (agent control,
//     shares the SessionManager so WriteLock arbitrates agent vs human).
//   • GET  /ws/:id         — human watch+intervene WebSocket (tmux primitives,
//     no PTY): capture-pane init → pipe-pane stream out, send-keys in.
//   • GET  /healthz, static client at /*.
// Runs on Bun (createBunWebSocket); no node-pty (it fails under Bun and tmux
// gives us output/input/resize natively).

import type { SessionManager } from "@termbridge/core";
import { Hono } from "hono";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { createBridge } from "./bridge.js";
import { createToolDispatch } from "./http-tools.js";

const { upgradeWebSocket, websocket } = createBunWebSocket();

export interface TermbridgeServerOptions {
	manager: SessionManager;
	/** Directory of the built xterm client (vite output). */
	clientDir?: string;
	/** How often to poll recognizer events for attached WS clients (ms). */
	eventPollMs?: number;
}

export interface TermbridgeServer {
	app: Hono;
	websocket: typeof websocket;
}

export function createTermbridgeServer(opts: TermbridgeServerOptions): TermbridgeServer {
	const { manager } = opts;
	const eventPollMs = opts.eventPollMs ?? 500;
	const tools = createToolDispatch(manager);
	const app = new Hono();

	app.get("/healthz", (c) => c.json({ ok: true, tools: tools.names }));

	// Agent-facing §6 tool surface (open_session, send_text, …) over HTTP.
	app.post("/api/tool/:name", async (c) => {
		const name = c.req.param("name") ?? "";
		const body = await c.req.json().catch(() => ({}));
		const res = await tools.call(name, body);
		return c.json(res, res.ok ? 200 : 400);
	});

	// Human watch + intervene.
	app.get(
		"/ws/:id",
		upgradeWebSocket((c) => {
			const id = c.req.param("id") ?? "";
			let bridge: ReturnType<typeof createBridge> | null = null;
			let timer: ReturnType<typeof setInterval> | null = null;
			return {
				async onOpen(_evt, ws) {
					const session = manager.get(id);
					if (!session) {
						ws.send(JSON.stringify({ type: "error", message: "no_session" }));
						ws.close();
						return;
					}
					bridge = createBridge(session, { send: (d) => ws.send(d) });
					await bridge.start();
					timer = setInterval(() => {
						bridge?.pollEvents().catch(() => {});
					}, eventPollMs);
				},
				async onMessage(evt, _ws) {
					const data =
						typeof evt.data === "string"
							? evt.data
							: new TextDecoder().decode(evt.data as ArrayBuffer);
					await bridge?.handleMessage(data);
				},
				onClose() {
					if (timer) {
						clearInterval(timer);
					}
					bridge?.stop();
				},
			};
		}),
	);

	// Static xterm client (vite build output). Best-effort: 404s if not built.
	const clientDir = opts.clientDir ?? "./packages/server/client/dist";
	app.get("/", serveStatic({ path: `${clientDir}/index.html` }));
	app.use("/*", serveStatic({ root: clientDir }));

	return { app, websocket };
}
