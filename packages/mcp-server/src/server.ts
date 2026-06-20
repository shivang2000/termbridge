// createServer — builds the termbridge MCP server over a SessionManager.
// D3: this is the ONLY package that imports the MCP SDK; core stays MCP-free.
// Each §6 tool spec is registered with its zod RAW SHAPE inputSchema, and every
// handler is wrapped so success → formatTextResponse and any throw →
// formatErrorResponse (so a tool failure becomes an MCP error result, not a
// transport crash).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionManager } from "@termbridge/core";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import { createToolSpecs } from "./tools.js";

export interface CreateServerOptions {
	/** Inject a SessionManager (tests/embedding). Defaults to a fresh one. */
	manager?: SessionManager;
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
	const manager = opts.manager ?? new SessionManager();
	const server = new McpServer({ name: "termbridge", version: "0.1.0" });

	for (const spec of createToolSpecs(manager)) {
		server.registerTool(
			spec.name,
			{ description: spec.description, inputSchema: spec.inputSchema },
			async (args: unknown) => {
				try {
					return formatTextResponse(await spec.handler(args));
				} catch (e) {
					return formatErrorResponse(e);
				}
			},
		);
	}

	return server;
}
