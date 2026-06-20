// M1 smoke — drives a REAL local tmux session through @termbridge/core.
// Run: bun scripts/smoke-m1.ts   (requires tmux on PATH)
//
// Asserts the headline M1 loop: open → sendText → waitForIdle → readScreen,
// plus a sendControl("C-c") interrupt of a blocking `sleep`.

import { SessionManager } from "../packages/core/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
	}
}

const mgr = new SessionManager();
let id: string | undefined;

try {
	const session = await mgr.open({ env: "local", cwd: process.cwd() });
	id = mgr.list()[0]?.id;
	assert(id, "session registered with an id");
	console.log(`[smoke] opened session ${session.name} (id=${id})`);

	// 1) echo hi → wait for idle → screen contains "hi"
	const sent = await session.sendText("echo smoke-hi-123", { enter: true });
	assert(sent.ok, `sendText accepted (got ${JSON.stringify(sent)})`);
	const idle = await session.waitForIdle(400, 8000);
	console.log(`[smoke] waitForIdle → ${JSON.stringify(idle)}`);
	const screen1 = await session.readScreen();
	assert(
		screen1.includes("smoke-hi-123"),
		`screen shows the echoed marker\n--- screen ---\n${screen1}`,
	);
	console.log("[smoke] ✓ echo + waitForIdle + readScreen");

	// 2) sleep 30 (blocks) → C-c interrupts → a follow-up command must run
	await session.sendText("sleep 30", { enter: true });
	await session.waitForIdle(300, 3000); // command line echoed, then quiet while sleeping
	const ctrl = await session.sendControl("C-c");
	assert(ctrl.ok, "sendControl C-c accepted");
	await session.sendText("echo smoke-back-456", { enter: true });
	const back = await session.waitForText("smoke-back-456", 8000);
	assert(
		back.matched,
		`C-c interrupted sleep so the next command ran\n--- screen ---\n${back.screen}`,
	);
	console.log("[smoke] ✓ sendControl C-c interrupt");

	console.log("\n[smoke] M1 SMOKE PASSED ✅");
} catch (err) {
	console.error(`\n[smoke] M1 SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`);
	process.exitCode = 1;
} finally {
	if (id) {
		await mgr.close(id);
		console.log("[smoke] cleaned up session");
	}
}
