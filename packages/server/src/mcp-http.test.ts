import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Environment, PtyObserver, SessionManager } from "@termbridge/core";
import { startServer } from "./index.js";
import { createTermbridgeServer } from "./server.js";

/** A no-tmux manager (mirrors http-tools.test.ts) so the MCP path is exercised
 *  in-memory: open/send/close all succeed against the fake Environment. */
function fakeManager(): SessionManager {
	const env: Environment = {
		kind: "local",
		ensureSession: () => Promise.resolve(),
		tmux: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
		destroySession: () => Promise.resolve(),
		listSessions: () => Promise.resolve([]),
	};
	let n = 0;
	return new SessionManager({
		envFactory: () => env,
		observerFactory: () => new PtyObserver({ clock: () => 0 }),
		idGen: () => `id${++n}`,
	});
}

/** Parse a tool result's first text content block as JSON (mirrors smoke-m3). */
function parse<T>(res: unknown): T {
	const r = res as {
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	const block = r.content?.[0];
	if (block?.type !== "text" || typeof block.text !== "string") {
		throw new Error("tool did not return a text block");
	}
	if (r.isError) throw new Error(`tool error: ${block.text}`);
	return JSON.parse(block.text) as T;
}

describe("MCP streamable-HTTP /mcp", () => {
	test("401 without the token (guard parity with /api/tool)", async () => {
		const { app } = createTermbridgeServer({ manager: fakeManager(), token: "sek" });
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
	});

	test("an HTTP MCP client drives the 13 tools over the SHARED SessionManager", async () => {
		const manager = fakeManager();
		const { server, port, token, mcp } = startServer({
			manager,
			token: "sek",
			port: 0,
		});
		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
		});
		const client = new Client({ name: "termbridge-test", version: "0.1.0" });
		try {
			await client.connect(transport);
			const tools = await client.listTools();
			expect(tools.tools).toHaveLength(13);
			expect(mcp.size).toBe(1); // one live MCP client session

			const opened = parse<{ id: string }>(
				await client.callTool({ name: "open_session", arguments: { cwd: "/w" } }),
			);
			expect(opened.id).toBe("id1");
			// THE proof: the id opened over the HTTP MCP transport is registered in
			// the SERVER's single SessionManager — the browser watches this session.
			expect(manager.list().some((s) => s.id === opened.id)).toBe(true);

			const sent = parse<{ ok: boolean }>(
				await client.callTool({
					name: "send_text",
					arguments: { id: opened.id, text: "hi" },
				}),
			);
			expect(sent.ok).toBe(true);

			const listed = parse<{ sessions: Array<{ id: string }> }>(
				await client.callTool({ name: "list_sessions", arguments: {} }),
			);
			expect(listed.sessions.some((s) => s.id === opened.id)).toBe(true);

			const closed = parse<{ ok: boolean }>(
				await client.callTool({
					name: "close_session",
					arguments: { id: opened.id },
				}),
			);
			expect(closed.ok).toBe(true);

			// Explicit DELETE terminates the MCP client session on the server
			// (client.close() only tears down the client; terminateSession sends
			// the spec's DELETE → onsessionclosed → session removed).
			await transport.terminateSession();
			expect(mcp.size).toBe(0);
		} finally {
			await client.close();
			await mcp.close();
			server.stop();
		}
	});

	test("unknown Mcp-Session-Id → 404 (no transport minted)", async () => {
		const { app } = createTermbridgeServer({ manager: fakeManager(), token: "sek" });
		const res = await app.request("/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"mcp-session-id": "never-existed",
				authorization: "Bearer sek",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(res.status).toBe(404);
	});
});
