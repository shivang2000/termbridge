// Reference: how an MCP agent drives a piloted `claude` session through termbridge.
//
// This is the canonical loop every consumer (Hermes / paperclip / opencode / a
// custom agent) reimplements — termbridge ships primitives only (D8), not a driver.
// Run:  TERMBRIDGE_HOME=~/.termbridge/home bun examples/drive-claude.ts <cwd> "<task>"
//   (best inside the termbridge:dev image; env:"local" there. On macOS host use env:"docker".)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cwd = process.argv[2] ?? process.cwd();
const task = process.argv[3] ?? "Summarize this repo in one sentence, then stop.";
const ENV = (process.env.TERMBRIDGE_SMOKE_ENV ?? "local") as "local" | "docker";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "packages", "mcp-server", "src", "stdio.ts");

const client = new Client({ name: "drive-claude", version: "0.1.0" });
const transport = new StdioClientTransport({
	command: "bun",
	args: [serverEntry],
	env: { ...(process.env as Record<string, string>) },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RecognizedEvent {
	kind: string;
	data: Record<string, unknown>;
	suggestedKeys: string[];
}

/** Call a termbridge tool and JSON-parse its single text content block. */
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const res = (await client.callTool({ name, arguments: args })) as {
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	const text = res.content?.[0]?.text ?? "{}";
	if (res.isError) {
		throw new Error(`tool ${name} error: ${text}`);
	}
	return JSON.parse(text) as T;
}

let id: string | undefined;
try {
	await client.connect(transport);

	const opened = await call<{ id: string; name: string }>("open_session", {
		env: ENV,
		cwd,
		cmd: "claude",
		cols: 200,
		rows: 50,
	});
	id = opened.id;
	console.log(`opened ${opened.name} (id=${id}) in ${cwd}`);

	let sinceOffset = 0;
	let taskSent = false;
	let backoffMs = 0;
	const start = Date.now();

	while (Date.now() - start < 180_000) {
		// 1) Drain recognizer events and answer prompts.
		const { events, nextOffset } = await call<{ events: RecognizedEvent[]; nextOffset: number }>(
			"read_events",
			{ id, sinceOffset },
		);
		sinceOffset = nextOffset;
		for (const ev of events) {
			if (ev.kind === "needs_login") {
				throw new Error(
					"session is logged out — run the one-time `claude` login into TERMBRIDGE_HOME",
				);
			}
			if (ev.kind === "rate_limited") {
				backoffMs = Math.min(backoffMs * 2 || 5_000, 60_000); // exponential back off
				console.warn(
					`rate limited (${String(ev.data.resetsAt ?? "?")}) — backing off ${backoffMs}ms`,
				);
				await sleep(backoffMs);
			}
			if (ev.kind === "claude-permission" || ev.kind === "generic-yn") {
				const key = ev.suggestedKeys[0] ?? "1";
				await call("send_text", { id, text: key, enter: false });
				console.log(`answered ${ev.kind} → "${key}"`);
			}
			if (ev.kind === "human_took_over") {
				console.log("human is driving — yielding");
			}
		}

		// 2) Send the task once the session has settled.
		if (!taskSent && Date.now() - start > 6_000) {
			await call("send_text", { id, text: task, enter: true });
			taskSent = true;
			console.log(`sent task: ${task}`);
		}

		// 3) Let it work, then peek the screen (replace with your own done-condition).
		await call("wait_for_idle", { id, quietMs: 800, timeoutMs: 8_000 });
		const { screen } = await call<{ screen: string }>("read_screen", { id });
		process.stdout.write(`\n--- screen tail ---\n${screen.split("\n").slice(-6).join("\n")}\n`);
		await sleep(1_000);
	}
} finally {
	if (id) {
		await call("close_session", { id }).catch(() => {});
	}
	await client.close();
}
