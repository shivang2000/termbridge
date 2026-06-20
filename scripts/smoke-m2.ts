// M2 smoke — drives a REAL per-session Docker container through @termbridge/core.
// Run on the HOST: bun scripts/smoke-m2.ts   (requires docker daemon + the
// `termbridge:dev` image; tmux runs INSIDE the container, host tmux untouched).
//
// Proves the same M1 piloting loop works with env:"docker", AND that the
// bind-mounted pipe dir feeds the host-side observer (readNewOutput sees output).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../packages/core/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

// pipeDir lives under the repo (/Users…) so Docker Desktop can bind-mount it.
const pipeDir = mkdtempSync(join(process.cwd(), ".tb-smoke-"));
const mgr = new SessionManager({ pipeDir });
let id: string | undefined;
let container: string | undefined;

try {
	const session = await mgr.open({ env: "docker", cwd: process.cwd() });
	const info = mgr.list()[0];
	id = info?.id;
	container = `termbridge-${session.name}`;
	assert(id && info?.env === "docker", "docker session registered");
	console.log(`[smoke] opened docker session ${session.name} (container=${container})`);

	// 1) echo marker → idle → screen AND observer buffer contain it
	await session.sendText("echo smoke-docker-789", { enter: true });
	const idle = await session.waitForIdle(400, 15000);
	console.log(`[smoke] waitForIdle → ${JSON.stringify(idle)}`);
	const screen = await session.readScreen();
	assert(screen.includes("smoke-docker-789"), `screen shows marker\n--- screen ---\n${screen}`);
	const out = session.readNewOutput();
	assert(
		out.data.includes("smoke-docker-789"),
		`observer (bind-mounted pipe) captured output — proves the Docker pipe wiring\n--- buffer ---\n${out.data}`,
	);
	console.log("[smoke] ✓ echo + waitForIdle + readScreen + observer buffer (mounted pipe)");

	// 2) sleep (blocks) → C-c interrupt → follow-up command must run
	await session.sendText("sleep 30", { enter: true });
	await session.waitForIdle(300, 5000);
	const ctrl = await session.sendControl("C-c");
	assert(ctrl.ok, "sendControl C-c accepted");
	await session.sendText("echo smoke-back-012", { enter: true });
	const back = await session.waitForText("smoke-back-012", 15000);
	assert(
		back.matched,
		`C-c interrupted sleep so the next command ran\n--- screen ---\n${back.screen}`,
	);
	console.log("[smoke] ✓ sendControl C-c interrupt");

	await mgr.close(id);
	id = undefined;
	// 3) container is gone after close()
	const remaining = execFileSync("docker", ["ps", "-aq", "--filter", `name=^${container}$`])
		.toString()
		.trim();
	assert(remaining === "", `container removed after close (docker ps returned: "${remaining}")`);
	console.log("[smoke] ✓ container removed on close");

	console.log("\n[smoke] M2 SMOKE PASSED ✅");
} catch (err) {
	console.error(`\n[smoke] M2 SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`);
	process.exitCode = 1;
} finally {
	if (id) await mgr.close(id);
	// belt-and-suspenders container cleanup
	if (container) {
		try {
			execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
		} catch {
			// already gone
		}
	}
	rmSync(pipeDir, { recursive: true, force: true });
}
