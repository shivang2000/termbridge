#!/usr/bin/env bun
// @termbridge/server entry. Starts the unified server on Bun.

import { randomUUID } from "node:crypto";
import { SessionManager } from "@termbridge/core";
import { createTermbridgeServer } from "./server.js";

export type { Bridge, BridgeSessionView, ClientFrame, ServerFrame, WsLike } from "./bridge.js";
export { createBridge } from "./bridge.js";
export type { ToolDispatch, ToolResult } from "./http-tools.js";
export { createToolDispatch } from "./http-tools.js";
export type { McpHttpHandler, McpHttpHandlerOptions } from "./mcp-http.js";
export { createMcpHttpHandler } from "./mcp-http.js";
export type { TermbridgeServer, TermbridgeServerOptions } from "./server.js";
export { createTermbridgeServer } from "./server.js";

export interface StartOptions {
	port?: number;
	/** Bind address. Defaults to HOST or 127.0.0.1 (loopback) — opt into a public bind explicitly. */
	host?: string;
	/** Bearer token. Defaults to TERMBRIDGE_TOKEN or a generated UUID (printed on start). */
	token?: string;
	manager?: SessionManager;
	clientDir?: string;
}

/** Start the unified server. Returns the Bun server handle + the SessionManager + token. */
export function startServer(opts: StartOptions = {}) {
	const manager = opts.manager ?? new SessionManager();
	const port = opts.port ?? Number(process.env.PORT ?? 8787);
	const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
	const token = opts.token ?? process.env.TERMBRIDGE_TOKEN ?? randomUUID();
	const allowedOrigins = [
		`http://localhost:${port}`,
		`http://127.0.0.1:${port}`,
		`http://${host}:${port}`,
	];
	const { app, websocket, mcp } = createTermbridgeServer({
		manager,
		token,
		allowedOrigins,
		clientDir: opts.clientDir,
	});
	const server = Bun.serve({ port, hostname: host, fetch: app.fetch, websocket });
	// Return the ACTUAL bound port (server.port), not the requested one — when
	// port:0 (ephemeral) is requested by tests/smokes the caller needs the real
	// port to reach the server. NOTE: allowedOrigins above were computed from the
	// requested port; with port:0 they carry :0 and won't match a real browser
	// origin — acceptable because port:0 is a test/smoke-only pattern
	// (programmatic clients, no browser WS); real browser access always uses a
	// fixed port (8787 / PORT), where the origins match.
	return { server, manager, port: server.port, host, token, mcp };
}

if (import.meta.main) {
	const { port, host, token } = startServer();
	console.error(`[termbridge] server on http://${host}:${port}  (token: ${token})`);
	if (host !== "127.0.0.1" && host !== "localhost") {
		console.error(
			"[termbridge] WARNING: bound to a non-loopback address — exposed beyond this host.",
		);
	}
}
