// createServer — builds the termbridge MCP server over a SessionManager, OR (proxy
// mode) over a remote caller that forwards to a running unified server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionManager } from "@termbridge/core";
import { sandboxProviderFromEnv } from "@termbridge/sandbox-e2b";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import { createRemoteCaller, createRemoteToolSpecs } from "./remote.js";
import { createToolSpecs, type ToolSpec } from "./tools.js";

export interface CreateServerOptions {
	/** Inject a SessionManager (tests/embedding). Defaults to a fresh one. */
	manager?: SessionManager;
	/** Proxy mode: forward every tool to a running unified server (browser-watchable). */
	remote?: { serverUrl: string; token: string };
}

/** Default manager: enables env:"sandbox" when E2B_API_KEY is set (P1.1). */
function defaultManager(): SessionManager {
	const sandboxProvider = sandboxProviderFromEnv();
	return new SessionManager(sandboxProvider ? { sandboxProvider } : {});
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
	const specs: ToolSpec[] = opts.remote
		? createRemoteToolSpecs(createRemoteCaller(opts.remote))
		: createToolSpecs(opts.manager ?? defaultManager());
	const server = new McpServer({ name: "termbridge", version: "0.1.0" });
	for (const spec of specs) {
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
