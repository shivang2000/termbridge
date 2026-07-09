#!/usr/bin/env bun
// Live Cloudflare Containers smoke — create container instance, exec, destroy.
// Requires deployed control Worker (scripts/deploy-cloudflare-sandbox.ts) and:
//   CLOUDFLARE_SANDBOX_WORKER_URL, CLOUDFLARE_CONTROL_TOKEN (or API token)
//   bun --env-file=.env scripts/smoke-sandbox-cloudflare.ts
// Always destroys the container id in finally.
import { SessionManager } from "../packages/core/src/index.ts";
import {
	CloudflareSandboxProvider,
	createCloudflareClientFromEnv,
} from "../packages/sandbox-cloudflare/src/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

async function main() {
	const hasWorker = Boolean(process.env.CLOUDFLARE_SANDBOX_WORKER_URL);
	const hasToken = Boolean(
		process.env.CLOUDFLARE_CONTROL_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
	);
	const hasAccount = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);

	// Auth-only path when worker not deployed yet
	if (!hasWorker) {
		if (!process.env.CLOUDFLARE_API_TOKEN || !hasAccount) {
			console.log(
				"[smoke-cf] CLOUDFLARE_API_TOKEN / ACCOUNT_ID not set — skip (exit 0)",
			);
			return;
		}
		const token = process.env.CLOUDFLARE_API_TOKEN!;
		const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
		const v = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const j = (await v.json()) as { success?: boolean };
		assert(v.ok && j.success, "token verify failed");
		console.log("[smoke-cf] ✓ API token active (auth-only mode)");
		console.log(
			"[smoke-cf] Deploy the control Worker for full create/exec/destroy:",
		);
		console.log("  bun --env-file=.env scripts/deploy-cloudflare-sandbox.ts");
		console.log(
			"[smoke-cf] then re-run this smoke with CLOUDFLARE_SANDBOX_WORKER_URL set.",
		);
		console.log("\n[smoke-cf] PASSED ✅ (auth only — no containers created)");
		return;
	}

	if (!hasToken) {
		console.log("[smoke-cf] control token missing — skip (exit 0)");
		return;
	}

	const client = createCloudflareClientFromEnv();
	const provider = new CloudflareSandboxProvider({ client });
	const manager = new SessionManager({ sandboxProvider: provider, maxSessions: 1 });
	let sessionId: string | undefined;
	let ok = false;
	try {
		console.log("[smoke-cf] creating container via control Worker…");
		const session = await manager.open({
			env: "sandbox",
			cwd: "/root",
			cmd: "bash",
		});
		sessionId = session.id;
		console.log(
			`[smoke-cf] opened session=${sessionId} cfId=${provider.id ?? "?"}`,
		);
		assert(manager.list().some((s) => s.id === sessionId), "in registry");
		await session.sendText("echo cf-marker-99\n", { enter: false });
		await session.waitForIdle(400, 30000);
		const screen = await session.readScreen();
		assert(screen.includes("cf-marker-99"), `marker missing\n${screen}`);
		console.log("[smoke-cf] ✓ open + drive + read_screen");
		await manager.close(sessionId);
		sessionId = undefined;
		ok = true;
		console.log("\n[smoke-cf] PASSED ✅ (container created and destroyed)");
	} catch (e) {
		console.error(`\n[smoke-cf] FAILED ❌\n${e instanceof Error ? e.stack : e}`);
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
			console.log("[smoke-cf] finally: provider.destroy (container killed)");
		} catch {
			/* never throw */
		}
	}
	process.exit(ok ? 0 : 1);
}

void main();
