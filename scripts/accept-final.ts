// FINAL ACCEPTANCE — through the unified server, an agent pilots a REAL logged-in
// claude TUI to make a code change in a bound git repo, while a human (WS) watches.
// Subscription auth (reuses the mounted creds volume), no API key. Run in Docker:
//   docker run … -v ~/.termbridge/home:/creds -e TERMBRIDGE_HOME=/creds … \
//     bash -lc 'set up /tmp/acceptrepo (git init + hello.txt) ; bun scripts/accept-final.ts'

import { readFileSync } from "node:fs";
import { startServer } from "../packages/server/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ACCEPT FAILED: ${msg}`);
}

const TOKEN = "accept-token";
const PORT = 8788;
const REPO = process.env.ACCEPT_REPO ?? "/tmp/acceptrepo";
const FILE = `${REPO}/hello.txt`;
const MARKER = "termbridge";
const base = `http://127.0.0.1:${PORT}`;

const { server, manager } = startServer({ port: PORT, host: "127.0.0.1", token: TOKEN });

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const r = await fetch(`${base}/api/tool/${name}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(args),
	});
	const j = (await r.json()) as { ok: boolean; data?: unknown; error?: string };
	assert(j.ok, `tool ${name}: ${j.error ?? "?"}`);
	return j.data as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileText = () => {
	try {
		return readFileSync(FILE, "utf8");
	} catch {
		return "";
	}
};

let id: string | undefined;
try {
	const opened = await tool<{ id: string; name: string }>("open_session", {
		env: "local",
		cwd: REPO,
		cmd: "claude",
		cols: 200,
		rows: 50,
	});
	id = opened.id;
	console.log(`[accept] opened claude session in ${REPO} (id=${id})`);

	// Human watches via the WS.
	const seen: string[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}?token=${TOKEN}`);
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(String(e.data)) as { type: string; data?: string };
		if (m.type === "stdout" && m.data) seen.push(m.data);
	});

	// Pilot claude to the main prompt and through the edit, answering its gates.
	const start = Date.now();
	let taskSent = false;
	let done = false;
	while (Date.now() - start < 150_000) {
		const { screen } = await tool<{ screen: string }>("read_screen", { id });
		if (/trust this folder/i.test(screen)) {
			await tool("send_text", { id, text: "1", enter: false });
			console.log("[accept] answered trust-folder prompt");
			await sleep(2500);
			continue;
		}
		if (/Do you want/i.test(screen) && /❯?\s*1\.\s*Yes/i.test(screen)) {
			await tool("send_text", { id, text: "1", enter: false });
			console.log("[accept] approved a claude permission prompt");
			await sleep(3000);
			continue;
		}
		if (fileText().includes(MARKER)) {
			done = true;
			break;
		}
		if (!taskSent && Date.now() - start > 7000) {
			await tool("send_text", {
				id,
				text: "Use your Edit tool to change hello.txt: replace the word World with termbridge. Make the edit directly, do not ask me questions.",
				enter: true,
			});
			taskSent = true;
			console.log("[accept] sent the coding task to claude");
			await sleep(5000);
			continue;
		}
		await sleep(2000);
	}

	const finalText = fileText();
	assert(
		done && finalText.includes(MARKER),
		`claude edited the bound repo file\n--- ${FILE} ---\n${finalText}`,
	);
	console.log(`[accept] ✓ claude made the change: ${JSON.stringify(finalText.trim())}`);
	assert(seen.join("").length > 0, "human WS streamed the live session");
	console.log("[accept] ✓ human watched the same session live over the WS");

	ws.close();
	await tool("close_session", { id });
	id = undefined;
	console.log(
		"\n[accept] FINAL ACCEPTANCE PASSED ✅  (real claude, subscription auth, repo change, human co-present)",
	);
} catch (err) {
	console.error(
		`\n[accept] FINAL ACCEPTANCE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`,
	);
	process.exitCode = 1;
} finally {
	if (id) await manager.close(id).catch(() => {});
	server.stop(true);
}
