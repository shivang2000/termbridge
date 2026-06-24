#!/usr/bin/env bun
// Proves the proxy shares the registry: start a unified server, open a session
// THROUGH the server's HTTP tool API, and assert the SAME id is visible in the
// SERVER's manager via list_sessions. Run on a machine with docker + a logged-in
// claude at ~/.termbridge/home:  bun scripts/smoke-watch.ts
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../packages/core/src/index.ts";
import { startServer } from "../packages/server/src/index.ts";

const pipeDir = mkdtempSync(join(tmpdir(), "tb-watch-"));
const homeDir = join(homedir(), ".termbridge", "home");
const mgr = new SessionManager({ maxSessions: 1, pipeDir, homeDir });
const { server, port, token } = startServer({ manager: mgr, port: 0 });
const base = `http://127.0.0.1:${port}`;

async function tool(name: string, args: unknown): Promise<unknown> {
	const res = await fetch(`${base}/api/tool/${name}?token=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args ?? {}),
	});
	const j = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
	if (!j.ok) throw new Error(`${name}: ${j.error}`);
	return j.data;
}

let ok = false;
try {
	const opened = (await tool("open_session", { env: "docker", cmd: "claude" })) as {
		id: string;
	};
	const listed = (await tool("list_sessions", {})) as { sessions: { id: string }[] };
	ok = listed.sessions.some((s) => s.id === opened.id);
	console.log(
		ok
			? `PASS — session ${opened.id} shared via the server registry`
			: "FAIL — id not in server registry",
	);
	await tool("close_session", { id: opened.id }).catch(() => {});
} catch (e) {
	console.error(`FAIL — ${e instanceof Error ? e.message : String(e)}`);
} finally {
	server.stop();
	rmSync(pipeDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
