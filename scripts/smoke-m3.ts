// M3 smoke — drives the termbridge MCP server end-to-end as a REAL MCP CLIENT.
// Run on the HOST: bun scripts/smoke-m3.ts   (requires a real tmux; set
// TERMBRIDGE_SMOKE_ENV=docker to exercise the Docker backend instead of local).
//
// Spawns src/stdio.ts via StdioClientTransport, connects an MCP Client, then
// walks the §6 loop: open_session → send_text → wait_for_idle → read_screen
// (assert the echoed marker is present) → close_session. Proves the SDK wiring,
// the tool envelopes, and core's piloting loop all line up over a real transport.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "packages", "mcp-server", "src", "stdio.ts");

/** Parse a tool result's first text content block as JSON. */
function parse<T>(res: { content?: Array<{ type: string; text?: string }> }): T {
	const block = res.content?.[0];
	assert(
		block && block.type === "text" && typeof block.text === "string",
		"tool returned a text block",
	);
	return JSON.parse(block.text as string) as T;
}

const smokeEnv = process.env.TERMBRIDGE_SMOKE_ENV ?? "local";

const client = new Client({ name: "termbridge-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
	command: "bun",
	args: [serverEntry],
	env: { ...(process.env as Record<string, string>), TERMBRIDGE_TMUX_SOCKET: "termbridge" },
});

let id: string | undefined;

try {
	await client.connect(transport);
	console.log("[smoke] connected to termbridge MCP server");

	const opened = parse<{ id: string; name: string; env: string }>(
		await client.callTool({
			name: "open_session",
			arguments: { env: smokeEnv, cwd: process.cwd() },
		}),
	);
	id = opened.id;
	assert(id, "open_session returned an id");
	console.log(`[smoke] opened session ${opened.name} (id=${id}, env=${opened.env})`);

	const sent = parse<{ ok: boolean }>(
		await client.callTool({
			name: "send_text",
			arguments: { id, text: "echo smoke-mcp-321", enter: true },
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
		screen.screen.includes("smoke-mcp-321"),
		`screen shows the echoed marker\n--- screen ---\n${screen.screen}`,
	);
	console.log("[smoke] ✓ open + send_text + wait_for_idle + read_screen");

	const closed = parse<{ ok: boolean }>(
		await client.callTool({ name: "close_session", arguments: { id } }),
	);
	assert(closed.ok, "close_session ok");
	id = undefined;
	console.log("[smoke] ✓ close_session");

	console.log("\n[smoke] M3 SMOKE PASSED ✅");
} catch (err) {
	console.error(`\n[smoke] M3 SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`);
	process.exitCode = 1;
} finally {
	if (id) {
		try {
			await client.callTool({ name: "close_session", arguments: { id } });
		} catch {
			// best-effort cleanup
		}
	}
	await client.close();
}
