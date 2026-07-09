#!/usr/bin/env bun
// Live Daytona smoke — create sandbox, install tmux, open SessionManager env:sandbox,
// drive a marker, destroy. ALWAYS kills the Daytona sandbox in finally.
//   bun --env-file=.env scripts/smoke-sandbox-daytona.ts
// No-ops exit 0 without DAYTONA_API_KEY.
import { SessionManager } from "../packages/core/src/index.ts";
import {
	createDaytonaClientFromEnv,
	DaytonaSandboxProvider,
} from "../packages/sandbox-daytona/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

async function main() {
	if (!process.env.DAYTONA_API_KEY) {
		console.log("[smoke-daytona] DAYTONA_API_KEY not set — skip (exit 0)");
		return;
	}
	const client = await createDaytonaClientFromEnv();
	const provider = new DaytonaSandboxProvider({ client });
	const manager = new SessionManager({ sandboxProvider: provider, maxSessions: 1 });
	let sessionId: string | undefined;
	let ok = false;
	try {
		const session = await manager.open({
			env: "sandbox",
			cwd: "/home/daytona",
			cmd: "bash",
		});
		sessionId = session.id;
		console.log(
			`[smoke-daytona] opened session=${sessionId} daytonaId=${provider.id ?? "?"}`,
		);
		assert(manager.list().some((s) => s.id === sessionId), "in registry");
		await session.sendText("echo daytona-marker-42\n", { enter: false });
		await session.waitForIdle(400, 20000);
		const screen = await session.readScreen();
		assert(screen.includes("daytona-marker-42"), `marker missing\n${screen}`);
		console.log("[smoke-daytona] ✓ open + drive + read_screen");
		await manager.close(sessionId);
		sessionId = undefined;
		ok = true;
		console.log("\n[smoke-daytona] PASSED ✅");
	} catch (e) {
		console.error(
			`\n[smoke-daytona] FAILED ❌\n${e instanceof Error ? e.stack : e}`,
		);
	} finally {
		if (sessionId) {
			try {
				await manager.close(sessionId);
			} catch {
				/* best-effort */
			}
		}
		try {
			await provider.destroy();
			console.log("[smoke-daytona] finally: provider.destroy (sandbox killed)");
		} catch {
			/* never throw */
		}
	}
	process.exit(ok ? 0 : 1);
}

void main();
