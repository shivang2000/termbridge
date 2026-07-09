// Publish the consumable libs to npm with a CORRECT published manifest.
//
// The repo keeps src-pointing exports for fast local dev; npm publish does NOT
// apply `publishConfig.exports`/`main`/`bin` (that's a pnpm/bun-only feature), so
// we promote those dist-pointing fields to the top level ONLY for the published
// tarball, then restore the original package.json exactly. Run from repo root
// (token must be in ~/.npmrc, or pass --otp via npm):
//   bun scripts/publish-npm.ts
// Build first: bunx turbo run build --filter=@termbridge/core … (this script does it).
//
// GATED: do not run without owner sign-off. sandbox-e2b is included in the
// allowlist (P2.2 prep) but still requires an explicit publish decision.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// dependency order: core first, then packages that depend on it.
// The "primary" versions list pins the deps that each package should declare
// after publish (workspace:* → semver). core@1.0.7 stays the published
// version so all consumers can resolve a single core release.
const PKG_VERSIONS: Record<string, string> = {
	core: "1.0.7",
	"mcp-server": "1.0.7",
	orchestrator: "1.0.7",
	"sandbox-e2b": "1.0.9",
};
const PKGS = Object.keys(PKG_VERSIONS);
const root = process.cwd();

function rewriteWorkspaceDeps(pkg: Record<string, unknown>, pinnedVersion: string): void {
	for (const depField of ["dependencies", "devDependencies", "peerDependencies"] as const) {
		const deps = pkg[depField] as Record<string, string> | undefined;
		if (!deps) continue;
		for (const [name, val] of Object.entries(deps)) {
			if (val === "workspace:*" || val.startsWith("workspace:")) {
				// Pin to the published version of the dependency, not the current
				// package's own version (which may have been bumped for a hot-fix
				// like sandbox-e2b → 1.0.9 but the published core is still 1.0.7).
				const pinned = PKG_VERSIONS[name.replace(/^@termbridge\//, "")];
				deps[name] = pinned ? `^${pinned}` : `^${pinnedVersion}`;
			}
		}
	}
}

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
	rewriteWorkspaceDeps(j, j.version);
	// Add a `default` + `require` export condition so both ESM (import) and
	// CJS (require) consumers can resolve. Also: `main`/`types` already at top
	// level, but if `exports` is set Node ignores `main` unless the entry
	// condition is reachable.
	if (j.exports && typeof j.exports === "object" && "." in j.exports) {
		const dot = (j.exports as Record<string, unknown>)["."];
		if (dot && typeof dot === "object") {
			const entry = dot as Record<string, string>;
			// ESM (import): keep
			entry.types = entry.types ?? j.types ?? "./dist/index.d.ts";
			entry.import = entry.import ?? j.main ?? "./dist/index.js";
			// CJS (require): add
			if (!entry.require) {
				entry.require = entry.import;
			}
			// Fallback
			entry.default = entry.default ?? entry.import;
		}
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

// --- @termbridge/server ---
// Ships TypeScript source directly (Bun runs TS); no dist swap needed.
// The client must be built first. workspace:* deps are rewritten to the
// published version so npm can resolve them.
{
	const p = "server";
	const pkgPath = join("packages", p, "package.json");
	const orig = readFileSync(pkgPath, "utf8");
	const j = JSON.parse(orig);
	const version: string = j.version;

	// Idempotent guard.
	let already = false;
	try {
		const out = execFileSync("npm", ["view", `@termbridge/${p}@${version}`, "version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		already = out.trim() === version;
	} catch {
		already = false;
	}
	if (already) {
		console.log(`[npm] @termbridge/${p}@${version} already published — skipping`);
	} else {
		// Build the web client so client/dist is present in the tarball.
		console.log("[npm] building @termbridge/server client…");
		execFileSync("bun", ["run", "build:client"], {
			cwd: join(root, "packages", p),
			stdio: "inherit",
		});

		// Rewrite workspace:* → ^<version> for npm compatibility.
		const published = JSON.parse(orig);
		delete published.private;
		rewriteWorkspaceDeps(published, version);

		writeFileSync(pkgPath, `${JSON.stringify(published, null, "\t")}\n`);
		try {
			console.log(`[npm] publishing @termbridge/${p}@${version} …`);
			execFileSync("npm", ["publish", "-w", `@termbridge/${p}`, "--access", "public"], {
				cwd: root,
				stdio: "inherit",
			});
		} finally {
			writeFileSync(pkgPath, orig); // restore exactly
		}
	}
}

console.log("[npm] done.");
