// mcp-http.ts — MCP streamable-HTTP transport on the unified server (P1.2).
//
// Lets an MCP client (Hermes, Claude Code, Cursor, …) connect DIRECTLY to the
// unified Bun+Hono server over HTTP at POST/GET/DELETE /mcp, sharing its single
// SessionManager — so the browser watches the agent's sessions natively (no
// per-client stdio proxy), and remote MCP clients work across a network
// boundary. The 13-tool surface is the SAME one the stdio server and /api/tool
// expose (reuse createServer from @termbridge/mcp-server), so there is no
// second tool definition (D3). stdio stays the zero-infra default (non-goal:
// replacing it).
//
// Security: the route is token-gated by the CALLER (server.ts runs isAuthorized
// BEFORE delegating here, exactly like /api/tool/:name — agent-facing, token
// only, no Origin gate). This handler never reads the token itself; it only
// owns MCP-session bookkeeping. The guard reads headers/URL only and never
// consumes the request body, so the JSON-RPC body stays intact for the
// transport.
//
// The transport runs in STATEFUL mode: one {transport, McpServer} pair per MCP
// client session, keyed by the Mcp-Session-Id header the SDK mints during
// initialize. This is the documented, spec-correct pattern (the SDK's own
// docstring shows the Hono route delegating to transport.handleRequest) and
// supports SSE streaming + the initialize→requests→DELETE lifecycle real HTTP
// MCP clients expect. The termbridge tools are themselves stateless w.r.t. the
// MCP session (each carries its own session id into the SHARED SessionManager),
// but stateful mode is the robust default.

import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SessionManager } from "@termbridge/core";
import { createServer } from "@termbridge/mcp-server";

export interface McpHttpHandlerOptions {
	manager: SessionManager;
}

export interface McpHttpHandler {
	/** Route a raw Request (any method) to the right MCP session transport. */
	handle(req: Request): Promise<Response>;
	/** Close every live MCP session (graceful shutdown). */
	close(): Promise<void>;
	/** Number of live MCP client sessions (introspection / tests). */
	readonly size: number;
}

interface McpSession {
	transport: WebStandardStreamableHTTPServerTransport;
	server: ReturnType<typeof createServer>;
}

/** JSON-RPC error envelope for the one case we reject ourselves (unknown session). */
function jsonRpcError(status: number, code: number, message: string): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Build the /mcp request handler: one MCP server+transport per client session,
 * all sharing the unified server's single SessionManager.
 */
export function createMcpHttpHandler(opts: McpHttpHandlerOptions): McpHttpHandler {
	const { manager } = opts;
	const sessions = new Map<string, McpSession>();

	return {
		async handle(req: Request): Promise<Response> {
			const sessionId = req.headers.get("mcp-session-id") ?? undefined;

			// Existing session → route to its transport. The SDK handles POST
			// (requests/notifications), GET (standalone SSE), and DELETE (session
			// termination, which fires onsessionclosed → our cleanup) itself,
			// including its own session-id validation (404 on mismatch, 400 on
			// missing for a non-init request).
			if (sessionId) {
				const entry = sessions.get(sessionId);
				if (!entry) {
					return jsonRpcError(404, -32001, "Session not found");
				}
				return entry.transport.handleRequest(req);
			}

			// No session id → must be the initialize request. Mint a transport +
			// server pair over the SHARED manager and connect them. The SDK sets
			// transport.sessionId while processing initialize; if the request was
			// NOT an initialize it returns 400 ("Server not initialized") and no
			// id is produced — we close the orphan server so it never leaks.
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessionclosed: (sid) => {
					const e = sessions.get(sid);
					sessions.delete(sid);
					e?.server.close().catch(() => {});
				},
			});
			const server = createServer({ manager });
			await server.connect(transport);
			const response = await transport.handleRequest(req);
			if (transport.sessionId) {
				sessions.set(transport.sessionId, { transport, server });
			} else {
				await server.close().catch(() => {});
			}
			return response;
		},

		async close(): Promise<void> {
			const live = [...sessions.values()];
			sessions.clear();
			await Promise.all(live.map((s) => s.server.close().catch(() => {})));
		},

		get size(): number {
			return sessions.size;
		},
	};
}
