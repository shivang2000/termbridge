#!/usr/bin/env bun
// Cloudflare smoke — verifies API token + account access and lists Workers.
// Full container create/exec is Workers/Containers + Wrangler (not a pure REST
// sandbox API like E2B/Daytona). This smoke NEVER creates billable containers
// and never leaves workers behind.
//   bun --env-file=.env scripts/smoke-sandbox-cloudflare.ts
// No-ops exit 0 without CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`SMOKE ASSERT FAILED: ${msg}`);
}

async function cf(path: string, token: string) {
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});
	const body = (await res.json()) as {
		success: boolean;
		errors?: Array<{ message?: string }>;
		result?: unknown;
	};
	return { status: res.status, body };
}

async function main() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || !account) {
		console.log(
			"[smoke-cf] CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — skip (exit 0)",
		);
		return;
	}

	let ok = false;
	try {
		const verify = await cf("/user/tokens/verify", token);
		assert(verify.status === 200 && verify.body.success, "token verify failed");
		const status = (verify.body.result as { status?: string } | undefined)?.status;
		assert(status === "active", `token status=${status}`);
		console.log("[smoke-cf] ✓ API token active");

		const scripts = await cf(`/accounts/${account}/workers/scripts`, token);
		assert(scripts.status === 200 && scripts.body.success, "workers/scripts list failed");
		const list = Array.isArray(scripts.body.result) ? scripts.body.result : [];
		console.log(`[smoke-cf] ✓ account reachable; workers scripts count=${list.length}`);
		console.log(
			"[smoke-cf] note: full Containers lifecycle needs a deployed Worker (Wrangler);",
		);
		console.log(
			"[smoke-cf] this smoke does NOT create containers/workers so nothing to kill.",
		);
		ok = true;
		console.log("\n[smoke-cf] PASSED ✅ (auth + account; no resources created)");
	} catch (e) {
		console.error(`\n[smoke-cf] FAILED ❌\n${e instanceof Error ? e.stack : e}`);
	}
	process.exit(ok ? 0 : 1);
}

void main();
