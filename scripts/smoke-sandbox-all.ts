#!/usr/bin/env bun
// Run all sandbox provider smokes (creds-gated each). Loads .env if present via Bun.
//   bun --env-file=.env scripts/smoke-sandbox-all.ts
import { spawnSync } from "node:child_process";

const scripts = [
	"scripts/smoke-sandbox-e2b.ts",
	"scripts/smoke-sandbox-daytona.ts",
	"scripts/smoke-sandbox-cloudflare.ts",
];

let failed = 0;
for (const s of scripts) {
	console.log(`\n========== ${s} ==========`);
	const r = spawnSync("bun", ["--env-file=.env", s], {
		stdio: "inherit",
		cwd: process.cwd(),
		env: process.env,
	});
	if (r.status !== 0) {
		failed++;
		console.error(`[all] ${s} exited ${r.status}`);
	}
}

console.log(
	failed === 0
		? "\n[all] ALL SANDBOX SMOKES PASSED ✅"
		: `\n[all] ${failed} smoke(s) failed ❌`,
);
process.exit(failed === 0 ? 0 : 1);
