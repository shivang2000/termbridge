#!/usr/bin/env bun
// @termbridge/server entry. Starts the unified server on Bun.

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
	manager?: SessionManager;
	clientDir?: string;
}

/** Start the unified server. Returns the Bun server handle + the SessionManager. */
export function startServer(opts: StartOptions = {}) {
	const manager = opts.manager ?? new SessionManager();
	const { app, websocket } = createTermbridgeServer({ manager, clientDir: opts.clientDir });
	const port = opts.port ?? Number(process.env.PORT ?? 8787);
	const server = Bun.serve({ port, fetch: app.fetch, websocket });
	return { server, manager, port };
}

if (import.meta.main) {
	const { port } = startServer();
	console.error(`[termbridge] server listening on :${port}`);
}
