// Unified termbridge server (Bun + Hono). Owns ONE SessionManager and exposes:
//   • POST /api/tool/:name — the §6 tool surface over HTTP (agent control,
//     shares the SessionManager so WriteLock arbitrates agent vs human).
//   • GET  /ws/:id         — human watch+intervene WebSocket (tmux primitives,
//     no PTY): capture-pane init → pipe-pane stream out, send-keys in.
//   • GET  /healthz, static client at /*.
// Runs on Bun (createBunWebSocket); no node-pty (it fails under Bun and tmux
// gives us output/input/resize natively).
//
// SECURITY: this is a session-piloting control plane (send_text == remote command
// execution). The tool API and WS are gated by a bearer token (constant-time) and
// the WS additionally by an Origin allowlist (CSWSH defence); index.ts binds
// loopback by default. A missing token config means "unauthenticated" (tests only).

import type { SessionManager } from "@termbridge/core";
import { Hono } from "hono";
import { createBunWebSocket, serveStatic } from "hono/bun";
import { createBridge } from "./bridge.js";
import { isAuthorized, isOriginAllowed } from "./guard.js";
import { createToolDispatch } from "./http-tools.js";

const { upgradeWebSocket, websocket } = createBunWebSocket();

export interface TermbridgeServerOptions {
	manager: SessionManager;
	/** Bearer token required for /api/tool and /ws (`?token=` or `Authorization: Bearer`). Omit only in tests. */
	token?: string;
	/** Browser Origins allowed to open the WS (CSWSH defence). Native (no-Origin) clients are always allowed. */
	allowedOrigins?: string[];
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
	const { manager, token } = opts;
	const allowedOrigins = opts.allowedOrigins ?? [];
	const eventPollMs = opts.eventPollMs ?? 500;
	const tools = createToolDispatch(manager);
	const app = new Hono();

	app.get("/healthz", (c) => c.json({ ok: true, tools: tools.names }));

	// Agent-facing §6 tool surface (open_session, send_text, …) over HTTP — token-gated.
	app.post("/api/tool/:name", async (c) => {
		if (!isAuthorized({ token, url: c.req.url, authHeader: c.req.header("authorization") })) {
			return c.json({ ok: false, error: "unauthorized" }, 401);
		}
		const name = c.req.param("name") ?? "";
		const body = await c.req.json().catch(() => ({}));
		const res = await tools.call(name, body);
		return c.json(res, res.ok ? 200 : 400);
	});

	// Human watch + intervene — token-gated + Origin-allowlisted.
	app.get(
		"/ws/:id",
		upgradeWebSocket((c) => {
			const id = c.req.param("id") ?? "";
			const ok =
				isAuthorized({ token, url: c.req.url, authHeader: c.req.header("authorization") }) &&
				isOriginAllowed(c.req.header("origin"), allowedOrigins);
			if (!ok) {
				return {
					onOpen(_evt, ws) {
						ws.close(1008, "unauthorized");
					},
				};
			}
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
					try {
						await bridge?.handleMessage(data);
					} catch {
						// A failing tmux call (e.g. a dead pane) must not become an
						// unhandled WS rejection — keep the socket alive.
					}
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

	// One-click Claude login VIA the app: open (or reuse) a `claude` session and
	// send the human to the watch UI, where the oauth-url card lets them sign in.
	// The login persists on TERMBRIDGE_HOME and is reused by every later session,
	// so this is the one-time "log in to Claude through termbridge" entry point.
	app.get("/login", async (c) => {
		if (!isAuthorized({ token, url: c.req.url, authHeader: c.req.header("authorization") })) {
			return c.json({ ok: false, error: "unauthorized" }, 401);
		}
		let id: string;
		try {
			const session = await manager.open({ cmd: "claude" });
			id = session.id;
		} catch {
			// Cap reached or open failed — reuse an existing session if there is one.
			const existing = manager.list()[0];
			if (!existing) {
				return c.json({ ok: false, error: "could not open a session" }, 503);
			}
			id = existing.id;
		}
		const qs = token ? `?session=${id}&token=${encodeURIComponent(token)}` : `?session=${id}`;
		return c.redirect(`/${qs}`);
	});

	// Static xterm client (vite build output). Best-effort: 404s if not built.
	const clientDir = opts.clientDir ?? "./packages/server/client/dist";
	app.get("/", serveStatic({ path: `${clientDir}/index.html` }));
	app.use("/*", serveStatic({ root: clientDir }));

	return { app, websocket };
}
