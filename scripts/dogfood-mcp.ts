// DOGFOOD — exercise the EXACT path an external agent uses: a real MCP client over
// stdio (`claude mcp add -- bun stdio.ts`) spawns the termbridge MCP server, opens
// a Dockerized real `claude` session bound to a git repo, drives it to make a
// change (answering trust + permission prompts via read_events), and verifies it.
// Run on the host (the server spawns the Docker session; claude on subscription):
//   TERMBRIDGE_HOME=~/.termbridge/home bun scripts/dogfood-mcp.ts
// Prereqs: termbridge:dev image, one-time claude login in TERMBRIDGE_HOME, docker up.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function assert(c: unknown, m: string): asserts c {
	if (!c) throw new Error(`DOGFOOD FAILED: ${m}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const serverEntry = join(repoRoot, "packages", "mcp-server", "src", "stdio.ts");

// A real git repo for claude to edit (under the repo so Docker can bind-mount it).
const work = mkdtempSync(join(repoRoot, ".dogfood-"));
const pipeDir = join(work, "pipes");
mkdirSync(pipeDir, { recursive: true });
const FILE = join(work, "hello.txt");
writeFileSync(FILE, "Hello, World!\n");
execFileSync("git", ["init", "-q"], { cwd: work });
execFileSync("git", ["-c", "user.email=a@b.co", "-c", "user.name=t", "add", "-A"], { cwd: work });
execFileSync("git", ["-c", "user.email=a@b.co", "-c", "user.name=t", "commit", "-qm", "seed"], {
	cwd: work,
});

const client = new Client({ name: "dogfood", version: "0.1.0" });
const transport = new StdioClientTransport({
	command: "bun",
	args: [serverEntry],
	env: {
		...(process.env as Record<string, string>),
		TERMBRIDGE_PIPE_DIR: pipeDir,
		TERMBRIDGE_TMUX_SOCKET: "termbridge",
	},
});

interface Ev {
	kind: string;
	data: Record<string, unknown>;
	suggestedKeys: string[];
}
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const res = (await client.callTool({ name, arguments: args })) as {
		content?: Array<{ text?: string }>;
		isError?: boolean;
	};
	const text = res.content?.[0]?.text ?? "{}";
	assert(!res.isError, `tool ${name}: ${text}`);
	return JSON.parse(text) as T;
}
const fileText = () => {
	try {
		return readFileSync(FILE, "utf8");
	} catch {
		return "";
	}
};

let id: string | undefined;
try {
	await client.connect(transport);
	const tools = await client.listTools();
	assert(tools.tools.length === 12, `12 tools advertised (got ${tools.tools.length})`);
	console.log(`[dogfood] connected over stdio MCP — ${tools.tools.length} tools`);

	const opened = await call<{ id: string; name: string; env: string }>("open_session", {
		env: "docker",
		cwd: work,
		cmd: "claude",
		cols: 200,
		rows: 50,
	});
	id = opened.id;
	assert(opened.env === "docker", "session is docker-backed");
	console.log(`[dogfood] opened ${opened.name} (claude in Docker, repo ${work})`);

	let since = 0;
	let sent = false;
	const start = Date.now();
	while (Date.now() - start < 150_000) {
		const { events, nextOffset } = await call<{ events: Ev[]; nextOffset: number }>("read_events", {
			id,
			sinceOffset: since,
		});
		since = nextOffset;
		for (const ev of events) {
			if (ev.kind === "needs_login") throw new Error("logged out — re-run the one-time login");
			if (ev.kind === "rate_limited") {
				console.warn("[dogfood] rate_limited — backing off");
				await sleep(10_000);
			}
			if (ev.kind === "claude-permission" || ev.kind === "generic-yn") {
				await call("send_text", { id, text: ev.suggestedKeys[0] ?? "1", enter: false });
				console.log(`[dogfood] answered ${ev.kind} → ${ev.suggestedKeys[0] ?? "1"}`);
			}
		}
		// Fallback: also answer prompts visible on screen (recognizers are version-fragile).
		const { screen } = await call<{ screen: string }>("read_screen", { id });
		if (
			/trust this folder/i.test(screen) ||
			(/Do you want/i.test(screen) && /1\.\s*Yes/i.test(screen))
		) {
			await call("send_text", { id, text: "1", enter: false });
			await sleep(2500);
			continue;
		}
		if (fileText().includes("termbridge")) break;
		if (!sent && Date.now() - start > 7000) {
			await call("send_text", {
				id,
				text: "Use your Edit tool to change hello.txt: replace World with termbridge. Make the edit directly.",
				enter: true,
			});
			sent = true;
			console.log("[dogfood] sent task to claude");
			await sleep(5000);
		}
		await sleep(2000);
	}

	const out = fileText();
	assert(
		out.includes("termbridge"),
		`claude edited the repo via the stdio MCP path\n--- hello.txt ---\n${out}`,
	);
	console.log(`[dogfood] ✓ claude made the change over stdio MCP: ${JSON.stringify(out.trim())}`);
	await call("close_session", { id });
	id = undefined;
	console.log(
		"\n[dogfood] PASSED ✅  external MCP client → termbridge → real claude (subscription) → repo edit",
	);
} catch (err) {
	console.error(`\n[dogfood] FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`);
	process.exitCode = 1;
} finally {
	if (id) await call("close_session", { id }).catch(() => {});
	await client.close();
	try {
		execFileSync("docker", ["rm", "-f", `termbridge-${id ?? ""}`], { stdio: "ignore" });
	} catch {}
	rmSync(work, { recursive: true, force: true });
}
