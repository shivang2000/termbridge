// Concurrency smoke — open N real Docker sessions AT ONCE (the Hermes-fleet shape),
// proving per-session isolation + a race-safe concurrency cap. Uses shell sessions
// (no claude tokens). Run on the host (spawns real containers):
//   bun scripts/smoke-concurrency.ts
// Prereqs: termbridge:dev image + docker up.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConcurrencyLimitError, SessionManager } from "../packages/core/src/index.ts";

function assert(c: unknown, m: string): asserts c {
	if (!c) throw new Error(`CONCURRENCY SMOKE FAILED: ${m}`);
}
const N = 3;
const pipeDir = mkdtempSync(join(process.cwd(), ".dogfood-conc-"));
const mgr = new SessionManager({ maxSessions: N, pipeDir });
const ids: string[] = [];

try {
	// 1) Open N sessions CONCURRENTLY (the race window for the cap).
	const sessions = await Promise.all(
		Array.from({ length: N }, () => mgr.open({ env: "docker", cwd: process.cwd() })),
	);
	for (const s of sessions) ids.push(s.id);
	assert(mgr.list().length === N, `all ${N} concurrent opens registered`);
	assert(new Set(ids).size === N, "session ids are distinct");
	const containers = execFileSync("docker", ["ps", "-q", "--filter", "name=termbridge-"])
		.toString().trim().split("\n").filter(Boolean);
	assert(containers.length === N, `exactly ${N} containers running (got ${containers.length})`);
	console.log(`[conc] ✓ ${N} concurrent docker sessions, ${N} distinct containers`);

	// 2) The cap is race-safe: an (N+1)th open is rejected cleanly.
	let rejected = false;
	try {
		await mgr.open({ env: "docker", cwd: process.cwd() });
	} catch (e) {
		rejected = e instanceof ConcurrencyLimitError;
	}
	assert(rejected, "the (N+1)th concurrent open is rejected with ConcurrencyLimitError");
	assert(mgr.list().length === N, "cap not exceeded after the rejected open");
	console.log("[conc] ✓ cap holds — N+1 rejected, no overshoot");

	// 3) Isolation: each pane only sees its OWN marker (no cross-talk).
	await Promise.all(sessions.map((s, i) => s.sendText(`echo CONC-MARKER-${i}`, { enter: true })));
	await Promise.all(sessions.map((s) => s.waitForIdle(400, 8000)));
	for (let i = 0; i < N; i++) {
		const session = sessions[i];
		assert(session, `session ${i} present`);
		const screen = await session.readScreen();
		assert(screen.includes(`CONC-MARKER-${i}`), `session ${i} shows its own marker`);
		for (let j = 0; j < N; j++) {
			if (j !== i) assert(!screen.includes(`CONC-MARKER-${j}`), `session ${i} does NOT see session ${j}'s marker`);
		}
	}
	console.log("[conc] ✓ per-session isolation (no cross-talk between panes)");

	// 4) Clean teardown.
	await Promise.all(ids.map((id) => mgr.close(id)));
	ids.length = 0;
	const left = execFileSync("docker", ["ps", "-aq", "--filter", "name=termbridge-"]).toString().trim();
	assert(left === "", `all containers removed on close (left: "${left}")`);
	console.log("[conc] ✓ all sessions + containers torn down");

	console.log("\n[conc] CONCURRENCY SMOKE PASSED ✅");
} catch (err) {
	console.error(`\n[conc] CONCURRENCY SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`);
	process.exitCode = 1;
} finally {
	for (const id of ids) await mgr.close(id).catch(() => {});
	try { execFileSync("docker", ["ps", "-aq", "--filter", "name=termbridge-"]).toString().trim()
		.split("\n").filter(Boolean).forEach((c) => execFileSync("docker", ["rm", "-f", c], { stdio: "ignore" })); } catch {}
	rmSync(pipeDir, { recursive: true, force: true });
}
