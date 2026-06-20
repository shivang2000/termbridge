// M4 HOME-delivery smoke — proves AuthProvisioner's HOME actually reaches the
// session's pane shell over real tmux (`new-session -e HOME=...`). Run inside the
// termbridge:dev image: bun scripts/smoke-m4-home.ts   (local backend).
//
// This validates the mechanism that makes shared-subscription auth work; the full
// `claude auth login` + reuse is a separate, interactive step.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../packages/core/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

const home = mkdtempSync(join(process.cwd(), ".tb-m4-home-"));
const mgr = new SessionManager({ homeDir: home });
let id: string | undefined;

try {
	const session = await mgr.open({ env: "local", cwd: process.cwd() });
	id = mgr.list()[0]?.id;
	assert(id, "session registered");

	// 1) needs_login fires while the creds volume is empty.
	const ev1 = await session.readEvents();
	assert(
		ev1.events.some((e) => e.kind === "needs_login"),
		`needs_login queued for the logged-out creds volume\n${JSON.stringify(ev1.events)}`,
	);
	console.log("[smoke] ✓ needs_login surfaced for empty creds volume");

	// 2) HOME actually reaches the pane shell (the tmux -e mechanism).
	await session.sendText("echo HOME=$HOME", { enter: true });
	await session.waitForIdle(400, 8000);
	const screen = await session.readScreen();
	assert(
		screen.includes(`HOME=${home}`),
		`pane shell HOME points at the creds volume\n--- screen ---\n${screen}`,
	);
	console.log(`[smoke] ✓ HOME delivered to the session: ${home}`);

	// 3) Once a creds file exists, a NEW session no longer flags needs_login.
	writeFileSync(join(home, ".claude", ".credentials.json"), '{"fake":"creds"}');
	const session2 = await mgr.open({ env: "local", cwd: process.cwd() });
	const ev2 = await session2.readEvents();
	assert(
		!ev2.events.some((e) => e.kind === "needs_login"),
		"second session does NOT flag needs_login once creds exist",
	);
	console.log("[smoke] ✓ creds present → no needs_login (reuse path)");
	await mgr.close(mgr.list()[1]?.id ?? "");

	console.log("\n[smoke] M4 HOME SMOKE PASSED ✅");
} catch (err) {
	console.error(
		`\n[smoke] M4 HOME SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`,
	);
	process.exitCode = 1;
} finally {
	if (id) await mgr.close(id);
	rmSync(home, { recursive: true, force: true });
}
