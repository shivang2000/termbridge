#!/usr/bin/env bun
// Deploy termbridge Cloudflare Containers control Worker.
// Requires: docker running, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//   bun --env-file=.env scripts/deploy-cloudflare-sandbox.ts
// Prints CLOUDFLARE_SANDBOX_WORKER_URL=… for .env
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const workerDir = join(root, "packages/sandbox-cloudflare/worker");

function run(cmd: string, args: string[], env: Record<string, string | undefined> = {}) {
	const r = spawnSync(cmd, args, {
		cwd: workerDir,
		stdio: "inherit",
		env: { ...process.env, ...env },
	});
	if (r.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
	}
}

function main() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || !account) {
		console.error("Need CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in env");
		process.exit(1);
	}

	// Install worker deps
	console.log("[deploy-cf] installing worker deps…");
	run("bun", ["install"]);

	// Control token for the Worker (prefer dedicated secret)
	const control =
		process.env.CLOUDFLARE_CONTROL_TOKEN ||
		process.env.CLOUDFLARE_API_TOKEN ||
		randomBytes(24).toString("hex");

	console.log("[deploy-cf] setting CONTROL_TOKEN secret…");
	// wrangler secret put reads stdin
	const secret = spawnSync(
		"bunx",
		["wrangler", "secret", "put", "CONTROL_TOKEN", "--name", "termbridge-sandbox"],
		{
			cwd: workerDir,
			input: control,
			stdio: ["pipe", "inherit", "inherit"],
			env: {
				...process.env,
				CLOUDFLARE_API_TOKEN: token,
				CLOUDFLARE_ACCOUNT_ID: account,
			},
		},
	);
	if (secret.status !== 0) {
		console.warn("[deploy-cf] secret put failed (may already exist); continuing deploy…");
	}

	console.log("[deploy-cf] wrangler deploy (builds Docker image — first time is slow)…");
	try {
		run("bunx", ["wrangler", "deploy"], {
			CLOUDFLARE_API_TOKEN: token,
			CLOUDFLARE_ACCOUNT_ID: account,
		});
	} catch (e) {
		console.error(`
[deploy-cf] FAILED — common causes:
  1) Workers Free plan: Containers need Workers Paid
     → https://dash.cloudflare.com/?to=/:account/workers/plans
  2) Token missing Cloudchamber/Containers permission
     → API Tokens → Custom → Account → Cloudchamber → Edit
  3) Docker not running
`);
		throw e;
	}

	// Discover workers.dev URL via wrangler whoami / deployments is awkward;
	// try wrangler deployments list or construct from account subdomain.
	const who = spawnSync("bunx", ["wrangler", "deployments", "list", "--name", "termbridge-sandbox", "--json"], {
		cwd: workerDir,
		encoding: "utf8",
		env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
	});
	let url = process.env.CLOUDFLARE_SANDBOX_WORKER_URL ?? "";
	if (!url) {
		// Fallback: wrangler deploy prints URL; also try common pattern from workers.subdomain
		const out = spawnSync("bunx", ["wrangler", "whoami"], {
			cwd: workerDir,
			encoding: "utf8",
			env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
		});
		console.log(out.stdout);
		// User must set URL if we cannot parse — try API
	}

	// Resolve workers.dev subdomain via API
	const subRes = spawnSync(
		"curl",
		[
			"-s",
			"-H",
			`Authorization: Bearer ${token}`,
			`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
		],
		{ encoding: "utf8" },
	);
	try {
		const j = JSON.parse(subRes.stdout || "{}") as {
			result?: { subdomain?: string };
		};
		const sub = j.result?.subdomain;
		if (sub) {
			url = `https://termbridge-sandbox.${sub}.workers.dev`;
		}
	} catch {
		/* ignore */
	}

	if (!url) {
		console.log(
			"[deploy-cf] deploy finished — set CLOUDFLARE_SANDBOX_WORKER_URL to the workers.dev URL from wrangler output",
		);
		console.log("[deploy-cf] also set CLOUDFLARE_CONTROL_TOKEN if you used a dedicated control token");
		return;
	}

	console.log(`\n[deploy-cf] DONE ✅`);
	console.log(`Add to .env:`);
	console.log(`CLOUDFLARE_SANDBOX_WORKER_URL=${url}`);
	if (!process.env.CLOUDFLARE_CONTROL_TOKEN) {
		console.log(`CLOUDFLARE_CONTROL_TOKEN=${control}`);
		// Append to .env if present and missing
		const envPath = join(root, ".env");
		if (existsSync(envPath)) {
			let envText = readFileSync(envPath, "utf8");
			if (!envText.includes("CLOUDFLARE_SANDBOX_WORKER_URL=")) {
				envText += `\nCLOUDFLARE_SANDBOX_WORKER_URL=${url}\n`;
			} else {
				envText = envText.replace(
					/^CLOUDFLARE_SANDBOX_WORKER_URL=.*$/m,
					`CLOUDFLARE_SANDBOX_WORKER_URL=${url}`,
				);
			}
			if (!envText.includes("CLOUDFLARE_CONTROL_TOKEN=")) {
				envText += `CLOUDFLARE_CONTROL_TOKEN=${control}\n`;
			}
			writeFileSync(envPath, envText);
			console.log("[deploy-cf] wrote CLOUDFLARE_SANDBOX_WORKER_URL (+ CONTROL_TOKEN) into .env");
		}
	}
}

try {
	main();
} catch (e) {
	console.error(e);
	process.exit(1);
}
