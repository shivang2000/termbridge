#!/usr/bin/env bun
// @termbridge/server entry. Starts the unified server on Bun.

import { randomUUID } from "node:crypto";
import { SessionManager } from "@termbridge/core";
import { createTermbridgeServer } from "./server.js";

export type { Bridge, BridgeSessionView, ClientFrame, ServerFrame, WsLike } from "./bridge.js";
export { createBridge } from "./bridge.js";
export type { ToolDispatch, ToolResult } from "./http-tools.js";
export { createToolDispatch } from "./http-tools.js";
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
	const { app, websocket } = createTermbridgeServer({
		manager,
		token,
		allowedOrigins,
		clientDir: opts.clientDir,
	});
	const server = Bun.serve({ port, hostname: host, fetch: app.fetch, websocket });
	return { server, manager, port, host, token };
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
