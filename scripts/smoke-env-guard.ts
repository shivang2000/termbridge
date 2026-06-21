// Env-guard smoke — proves the docker-only guard end-to-end through the REAL
// stdio MCP transport (the exact path an untrusted caller like a chat gateway
// uses). With TERMBRIDGE_ALLOWED_ENVS=docker, an explicit env:"local" must be
// rejected BEFORE anything spawns — so this needs no docker and no creds.
//   bun scripts/smoke-env-guard.ts

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function assert(c: unknown, m: string): asserts c {
	if (!c) throw new Error(`ENV-GUARD SMOKE FAILED: ${m}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "packages", "mcp-server", "src", "stdio.ts");

const client = new Client({ name: "env-guard-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
	command: "bun",
	args: [serverEntry],
	env: {
		...(process.env as Record<string, string>),
		TERMBRIDGE_ALLOWED_ENVS: "docker", // lock the untrusted caller to containers
		TERMBRIDGE_TMUX_SOCKET: "termbridge",
	},
});

async function callRaw(name: string, args: Record<string, unknown>) {
	return (await client.callTool({ name, arguments: args })) as {
		content?: Array<{ text?: string }>;
		isError?: boolean;
	};
}

try {
	await client.connect(transport);

	// 1) Explicit env:"local" is rejected through the real transport (pre-spawn).
	const rejected = await callRaw("open_session", { env: "local", cwd: "/tmp" });
	const text = rejected.content?.[0]?.text ?? "";
	assert(rejected.isError === true, `open_session env:local must error (got isError=${rejected.isError}: ${text})`);
	assert(/not permitted|env_not_allowed/i.test(text), `rejection must explain the policy (got: ${text})`);
	console.log(`[env-guard] ✓ env:local rejected over stdio: ${text.slice(0, 100)}`);

	// 2) The rejected open created nothing.
	const ls = await callRaw("list_sessions", {});
	const sessions = JSON.parse(ls.content?.[0]?.text ?? "{}").sessions ?? [];
	assert(Array.isArray(sessions) && sessions.length === 0, `no session must exist after a rejected open (got ${sessions.length})`);
	console.log("[env-guard] ✓ no session was created by the rejected open");

	console.log("\n[env-guard] ENV-GUARD SMOKE PASSED ✅");
} catch (err) {
	console.error(`\n[env-guard] ENV-GUARD SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`);
	process.exitCode = 1;
} finally {
	await client.close().catch(() => {});
}
