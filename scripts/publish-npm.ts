// Publish the consumable libs to npm with a CORRECT published manifest.
//
// The repo keeps src-pointing exports for fast local dev; npm publish does NOT
// apply `publishConfig.exports`/`main`/`bin` (that's a pnpm/bun-only feature), so
// we promote those dist-pointing fields to the top level ONLY for the published
// tarball, then restore the original package.json exactly. Run from repo root
// (token must be in ~/.npmrc, or pass --otp via npm):
//   bun scripts/publish-npm.ts
// Build first: bunx turbo run build --filter=@termbridge/core … (this script does it).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PKGS = ["core", "mcp-server", "orchestrator"]; // dependency order: core first
const root = process.cwd();

// Fresh dist (excludes tests via tsconfig.build.json).
console.log("[npm] building…");
for (const p of PKGS) {
	execFileSync("rm", ["-rf", join("packages", p, "dist")]);
}
execFileSync(
	"bunx",
	[
		"turbo",
		"run",
		"build",
		"--force",
		...PKGS.map((p) => `--filter=@termbridge/${p}`),
	],
	{ cwd: root, stdio: "inherit" },
);

for (const p of PKGS) {
	const path = join("packages", p, "package.json");
	const orig = readFileSync(path, "utf8");
	const j = JSON.parse(orig);
	const pc = j.publishConfig ?? {};
	// Promote dist-pointing fields so the PUBLISHED manifest resolves to dist.
	for (const k of ["main", "types", "exports", "bin"] as const) {
		if (pc[k] !== undefined) j[k] = pc[k];
	}
	// Idempotent: skip a version that is already on the registry (safe CI re-runs).
	let already = false;
	try {
		const out = execFileSync("npm", ["view", `@termbridge/${p}@${j.version}`, "version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		already = out.trim() === j.version;
	} catch {
		already = false; // 404 = not published yet
	}
	if (already) {
		console.log(`[npm] @termbridge/${p}@${j.version} already published — skipping`);
		continue;
	}
	delete j.publishConfig;
	delete j.private;
	writeFileSync(path, `${JSON.stringify(j, null, "\t")}\n`);
	try {
		console.log(`[npm] publishing @termbridge/${p}@${j.version} …`);
		execFileSync("npm", ["publish", "-w", `@termbridge/${p}`, "--access", "public"], {
			cwd: root,
			stdio: "inherit",
		});
	} finally {
		writeFileSync(path, orig); // restore the src-pointing dev manifest exactly
	}
}
console.log("[npm] done.");
