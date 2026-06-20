#!/usr/bin/env bun
// stdio entrypoint — runs the termbridge MCP server over stdio so a client
// (Claude Code / paperclip / the M3 smoke) can spawn it as a subprocess and
// speak MCP. `runServer` is exported for embedding/tests; when this file is the
// process entry it is invoked directly.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/** Build the server and connect it to a stdio transport. Resolves once connected. */
export async function runServer(): Promise<void> {
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

if (import.meta.main) {
	void runServer().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
