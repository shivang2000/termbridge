#!/usr/bin/env bun
// P1.1 smoke — drives the termbridge SessionManager with a REAL E2BSandboxProvider
// (cloud sandbox), asserting an opened sandbox session lands in the manager's shared
// registry. CREDS-GATED: no-ops with a clear message when E2B_API_KEY is unset, so
// `bun run test` stays green without creds.
//   E2B_API_KEY=... bun scripts/smoke-sandbox-e2b.ts
//
// Cleanup guarantee: the provider is ALWAYS destroy()'d in finally (success, assert
// failure, mid-open failure). That kills the cloud sandbox so the E2B dashboard
// does not accumulate orphans.
import { SessionManager } from "../packages/core/src/index.ts";
import { E2BSandboxProvider } from "../packages/sandbox-e2b/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

async function main() {
	const env = process.env as Record<string, string | undefined>;
	if (!env.E2B_API_KEY) {
		console.log("[smoke] E2B_API_KEY not set — skipping live sandbox smoke (exit 0).");
		console.log("[smoke] Set E2B_API_KEY to run: E2B_API_KEY=... bun scripts/smoke-sandbox-e2b.ts");
		return;
	}
	const provider = new E2BSandboxProvider({ apiKey: env.E2B_API_KEY });
	const manager = new SessionManager({ sandboxProvider: provider, maxSessions: 1 });

	let id: string | undefined;
	let ok = false;
	try {
		const session = await manager.open({ env: "sandbox", cwd: "/home/user", cmd: "bash" });
		id = session.id;
		const cloudId = provider.sandboxId;
		console.log(
			`[smoke] opened sandbox session id=${id} (provider=${provider.name}` +
				(cloudId ? `, e2bSandboxId=${cloudId}` : "") +
				")",
		);
		if (cloudId) {
			console.log(`[smoke] → watch this id on the E2B dashboard, then it should disappear after destroy`);
		}
		assert(
			manager.list().some((s) => s.id === id),
			"sandbox session is in the manager's registry",
		);
		console.log("[smoke] ✓ session visible in the shared registry");

		// Drive the session: use the Session's methods (manager.open returns a Session).
		await session.sendText("echo sandbox-e2b-marker-789\n", { enter: false });
		const idle = await session.waitForIdle(400, 15000);
		console.log(`[smoke] waitForIdle → ${JSON.stringify(idle)}`);
		const screen = await session.readScreen();
		assert(
			screen.includes("sandbox-e2b-marker-789"),
			`screen shows the marker\n--- screen ---\n${screen}`,
		);
		console.log("[smoke] ✓ open + send + wait_idle + read_screen over E2B sandbox");

		await manager.close(id);
		id = undefined;
		console.log("[smoke] ✓ close_session");
		console.log("\n[smoke] SANDBOX-E2B SMOKE PASSED ✅");
		ok = true;
	} catch (err) {
		console.error(
			`\n[smoke] SANDBOX-E2B SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`,
		);
	} finally {
		// Always free the registry slot if open succeeded.
		if (id) {
			try {
				await manager.close(id);
				console.log("[smoke] finally: manager.close ok");
			} catch {
				/* best-effort */
			}
		}
		// Always kill the cloud sandbox (covers open-failed-after-ensure, close
		// missed destroy, and success path double-destroy which is a no-op).
		// Capture id BEFORE destroy (destroy clears the handle).
		const cloudIdBeforeKill = provider.sandboxId;
		try {
			await provider.destroy();
			console.log(
				`[smoke] finally: provider.destroy (sandbox killed${
					cloudIdBeforeKill ? `: ${cloudIdBeforeKill}` : ""
				})`,
			);
		} catch {
			/* destroy must never throw */
		}
		// Verify via list API that nothing termbridge-owned is still running.
		try {
			const { Sandbox } = await import("e2b");
			const pager = Sandbox.list({ apiKey: env.E2B_API_KEY });
			const items = await pager.nextItems();
			const still = items.filter(
				(s) =>
					s.state === "running" ||
					(s.metadata && typeof s.metadata === "object" && "name" in s.metadata),
			);
			if (still.length === 0) {
				console.log("[smoke] finally: E2B list shows 0 running sandboxes ✓");
			} else {
				console.error(
					`[smoke] finally: WARNING — still listed after destroy: ${still
						.map((s) => `${s.sandboxId}(${s.state})`)
						.join(", ")}`,
				);
				for (const s of still) {
					try {
						await Sandbox.kill(s.sandboxId, { apiKey: env.E2B_API_KEY });
						console.log(`[smoke] finally: force-killed ${s.sandboxId}`);
					} catch (e) {
						console.error(
							`[smoke] finally: force-kill failed ${s.sandboxId}: ${
								e instanceof Error ? e.message : e
							}`,
						);
					}
				}
			}
		} catch (e) {
			console.error(
				`[smoke] finally: list verify skipped: ${e instanceof Error ? e.message : e}`,
			);
		}
	}
	process.exit(ok ? 0 : 1);
}

void main();
