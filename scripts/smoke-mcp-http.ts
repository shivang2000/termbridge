#!/usr/bin/env bun
// P1.2 smoke — drives the termbridge MCP server over the STREAMABLE-HTTP
// transport (POST/GET/DELETE /mcp) as a REAL HTTP MCP CLIENT, against a real
// tmux local session, AND asserts the opened id is visible in the SERVER's
// SessionManager — proving an HTTP MCP client shares the browser's single
// registry (no per-client stdio proxy). Run on a host with tmux:
//   bun scripts/smoke-mcp-http.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SessionManager } from "../packages/core/src/index.ts";
import { startServer } from "../packages/server/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

/** Parse a tool result's first text content block as JSON (mirrors smoke-m3). */
function parse<T>(res: unknown): T {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	const block = r.content?.[0];
	assert(block?.type === "text" && typeof block.text === "string", "tool returned a text block");
	return JSON.parse(block.text as string) as T;
}

const pipeDir = mkdtempSync(join(tmpdir(), "tb-mcp-http-"));
const mgr = new SessionManager({ maxSessions: 1, pipeDir });
const { server, port, token, mcp } = startServer({ manager: mgr, port: 0 });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
	requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "termbridge-smoke-http", version: "0.1.0" });

let id: string | undefined;
let ok = false;
try {
	await client.connect(transport);
	const tools = await client.listTools();
	assert(tools.tools.length === 13, `13 tools advertised (got ${tools.tools.length})`);
	console.log(`[smoke] connected over streamable-HTTP MCP — ${tools.tools.length} tools`);

	const opened = parse<{ id: string; name: string; env: string }>(
		await client.callTool({
			name: "open_session",
			arguments: { env: "local", cwd: process.cwd() },
		}),
	);
	id = opened.id;
	assert(id, "open_session returned an id");
	console.log(`[smoke] opened session ${opened.name} (id=${id}, env=${opened.env})`);

	// THE proof: the id opened over HTTP MCP is in the SERVER's shared registry,
	// so the browser (served by the same server) watches this exact session.
	assert(
		mgr.list().some((s) => s.id === id),
		"session opened over HTTP MCP is in the server's SessionManager (one registry)",
	);
	console.log("[smoke] ✓ session is visible in the server's shared registry");

	const sent = parse<{ ok: boolean }>(
		await client.callTool({
			name: "send_text",
			arguments: { id, text: "echo smoke-mcp-http-321", enter: true },
		}),
	);
	assert(sent.ok, "send_text accepted");

	const idle = parse<{ idle: boolean }>(
		await client.callTool({
			name: "wait_for_idle",
			arguments: { id, quietMs: 400, timeoutMs: 15000 },
		}),
	);
	console.log(`[smoke] waitForIdle → ${JSON.stringify(idle)}`);

	const screen = parse<{ screen: string }>(
		await client.callTool({ name: "read_screen", arguments: { id } }),
	);
	assert(
		screen.screen.includes("smoke-mcp-http-321"),
		`screen shows the echoed marker\n--- screen ---\n${screen.screen}`,
	);
	console.log("[smoke] ✓ open + send_text + wait_for_idle + read_screen over HTTP MCP");

	const closed = parse<{ ok: boolean }>(
		await client.callTool({ name: "close_session", arguments: { id } }),
	);
	assert(closed.ok, "close_session ok");
	id = undefined;
	console.log("[smoke] ✓ close_session");

	await transport.terminateSession();
	console.log("[smoke] ✓ DELETE terminated the MCP client session");
	console.log("\n[smoke] MCP-HTTP SMOKE PASSED ✅");
	ok = true;
} catch (err) {
	console.error(
		`\n[smoke] MCP-HTTP SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`,
	);
} finally {
	if (id) {
		try {
			await client.callTool({ name: "close_session", arguments: { id } });
		} catch {
			// best-effort cleanup
		}
	}
	await client.close();
	await mcp.close();
	server.stop();
	rmSync(pipeDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
