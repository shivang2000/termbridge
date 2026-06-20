// M5 web smoke — runs the unified server + an agent (HTTP tool API) + a human
// (WebSocket) against ONE real tmux session, proving co-presence + WriteLock
// arbitration. Run INSIDE the termbridge:dev image: bun scripts/smoke-m5-web.ts

import { startServer } from "../packages/server/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

const TOKEN = "smoke-token-123";
const PORT = 8799;
const base = `http://127.0.0.1:${PORT}`;
const { server, manager } = startServer({ port: PORT, host: "127.0.0.1", token: TOKEN });

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const r = await fetch(`${base}/api/tool/${name}?token=${TOKEN}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	const j = (await r.json()) as { ok: boolean; data?: unknown; error?: string };
	assert(j.ok, `tool ${name} ok (${j.error ?? ""})`);
	return j.data as T;
}

let id: string | undefined;
try {
	// auth: no token must be rejected (control-plane is RCE-equivalent)
	const noAuth = await fetch(`${base}/api/tool/list_sessions`, { method: "POST", body: "{}" });
	assert(noAuth.status === 401, "tool API without token → 401");
	console.log("[smoke] ✓ tool API rejects missing token");

	const opened = await tool<{ id: string; name: string }>("open_session", {
		env: "local",
		cwd: process.cwd(),
	});
	id = opened.id;
	console.log(`[smoke] opened session ${opened.name} (id=${id})`);

	// human WS client
	const stdout: string[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}?token=${TOKEN}`);
	let initSeen = false;
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(String(e.data)) as { type: string; data?: string };
		if (m.type === "init") initSeen = true;
		if (m.type === "stdout" && m.data) stdout.push(m.data);
	});
	await new Promise<void>((res, rej) => {
		ws.addEventListener("open", () => res());
		ws.addEventListener("error", () => rej(new Error("ws error")));
	});
	await Bun.sleep(300);
	assert(initSeen, "WS received the init screen frame");
	console.log("[smoke] ✓ human WS attached (init frame)");

	// 1) AGENT types (no human activity yet → allowed)
	const a1 = await tool<{ ok: boolean }>("send_text", { id, text: "echo AGENT-LINE-A1" });
	assert(a1.ok, "agent send_text accepted before human activity");
	await Bun.sleep(700);

	// 2) HUMAN types over the WS
	ws.send(JSON.stringify({ type: "stdin", data: "echo HUMAN-LINE-H1\r" }));
	await Bun.sleep(1200);

	// 3) both lines are in the ONE shared pane
	const screen = await tool<{ screen: string }>("read_screen", { id });
	assert(screen.screen.includes("AGENT-LINE-A1"), `agent line in pane\n${screen.screen}`);
	assert(screen.screen.includes("HUMAN-LINE-H1"), `human line in pane\n${screen.screen}`);
	console.log("[smoke] ✓ agent + human both drive one pane");

	// human keystrokes streamed back to the WS too (co-presence)
	assert(stdout.join("").includes("HUMAN-LINE-H1"), "human input echoed to the WS stdout stream");
	console.log("[smoke] ✓ live output streamed over WS");

	// 4) WriteLock: a fresh human keystroke pauses the agent (human_took_over)
	ws.send(JSON.stringify({ type: "stdin", data: "x" }));
	await Bun.sleep(150);
	const blocked = await tool<{ ok: boolean; error?: string }>("send_text", {
		id,
		text: "echo NOPE",
	});
	assert(
		blocked.ok === false && blocked.error === "human_driving",
		"agent refused while human drives",
	);
	console.log("[smoke] ✓ human typing pauses the agent (human_driving)");

	// 5) auto-resume after the human idles past the WriteLock TTL (3s)
	await Bun.sleep(3300);
	const resumed = await tool<{ ok: boolean }>("send_text", { id, text: "echo RESUMED" });
	assert(resumed.ok, "agent resumes after human idle");
	console.log("[smoke] ✓ agent auto-resumes after idle");

	ws.close();
	await tool("close_session", { id });
	id = undefined;
	console.log("\n[smoke] M5 WEB SMOKE PASSED ✅");
} catch (err) {
	console.error(
		`\n[smoke] M5 WEB SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`,
	);
	process.exitCode = 1;
} finally {
	if (id) await manager.close(id).catch(() => {});
	server.stop(true);
}
