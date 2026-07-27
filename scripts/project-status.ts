// Canonical project status generator (Autonomous Local, Phase 0 Task 1).
//
// Hand-maintained status claims in README/ROADMAP drifted from reality (~900 tests
// vs a measured 762). This module makes docs/evidence/status.{json,md} the single
// generated source of truth, and `bun run status:check` fails CI when the tracked
// files drift from what the repository actually measures.
//
// Determinism contract: for a given commit, regeneration must be byte-stable, so
// `generatedAt` is the HEAD commit date (not wall-clock now) and package/check
// ordering is fixed. Wall-clock timestamps would make --check fail on every run.
//
// Usage:
//   bun scripts/project-status.ts            # write docs/evidence/status.{json,md}
//   bun scripts/project-status.ts --check    # regenerate in memory, diff, exit 1 on drift

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectStatusPackage {
	name: string;
	version: string;
	classification: string;
}

export interface ProjectStatusCheck {
	name: string;
	command: string;
	exitCode: number;
	passed: number | null;
	files: number | null;
}

export interface ProjectStatus {
	schemaVersion: 1;
	generatedAt: string;
	gitSha: string;
	packages: ProjectStatusPackage[];
	checks: ProjectStatusCheck[];
}

export interface CheckResult {
	exitCode: number;
	output: string;
}

export interface StatusEnvironment {
	readGitSha(root: string): Promise<string>;
	readGeneratedAt(root: string): Promise<string>;
	runCheck(command: string, cwd: string): Promise<CheckResult>;
}

/** The checks recorded in status.json, in fixed order. */
const STATUS_CHECKS: ReadonlyArray<{ name: string; command: string }> = [
	{ name: "lint", command: "bun run lint" },
	{ name: "typecheck", command: "bun run typecheck" },
	{ name: "test", command: "bun test" },
];

function git(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const defaultEnvironment: StatusEnvironment = {
	readGitSha: async (root) => git(root, ["rev-parse", "HEAD"]),
	// HEAD commit date keeps regeneration byte-stable for a given commit.
	readGeneratedAt: async (root) =>
		new Date(git(root, ["show", "-s", "--format=%cI", "HEAD"])).toISOString(),
	runCheck: async (command, cwd) => {
		const [file, ...args] = command.split(" ");
		if (!file) throw new Error("empty status check command");
		// bun's test runner prints its pass/fail summary on stderr — capture both
		// streams, and allow large outputs (the full suite exceeds the 1 MiB default).
		const proc = spawnSync(file, args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}${proc.error ? String(proc.error) : ""}`;
		return { exitCode: proc.status ?? 1, output };
	},
};

/** Parse bun's test-runner summary; nulls when the shape is not recognised. */
export function parseBunTestSummary(output: string): {
	passed: number | null;
	failed: number | null;
	expects: number | null;
	files: number | null;
} {
	const pass = output.match(/^\s*(\d+) pass$/m);
	const fail = output.match(/^\s*(\d+) fail$/m);
	const expects = output.match(/^\s*(\d+) expect\(\) calls$/m);
	const ran = output.match(/Ran \d+ tests? across (\d+) files?/);
	return {
		passed: pass?.[1] ? Number(pass[1]) : null,
		failed: fail?.[1] ? Number(fail[1]) : null,
		expects: expects?.[1] ? Number(expects[1]) : null,
		files: ran?.[1] ? Number(ran[1]) : null,
	};
}

function classifyPackage(manifest: { version: string; private?: boolean }): string {
	if (manifest.private === true) return "private";
	if (manifest.version.startsWith("0.")) return "experimental";
	return "published";
}

function collectPackages(root: string): ProjectStatusPackage[] {
	const packagesDir = join(root, "packages");
	if (!existsSync(packagesDir)) return [];
	const packages: ProjectStatusPackage[] = [];
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = join(packagesDir, entry.name, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			name?: string;
			version?: string;
			private?: boolean;
		};
		if (!manifest.name || !manifest.version) {
			throw new Error(`package manifest missing name/version: ${manifestPath}`);
		}
		packages.push({
			name: manifest.name,
			version: manifest.version,
			classification: classifyPackage({ version: manifest.version, private: manifest.private }),
		});
	}
	return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export async function collectProjectStatus(
	root: string,
	env: StatusEnvironment = defaultEnvironment,
): Promise<ProjectStatus> {
	const checks: ProjectStatusCheck[] = [];
	for (const { name, command } of STATUS_CHECKS) {
		const result = await env.runCheck(command, root);
		const summary = name === "test" ? parseBunTestSummary(result.output) : null;
		checks.push({
			name,
			command,
			exitCode: result.exitCode,
			passed: summary?.passed ?? null,
			files: summary?.files ?? null,
		});
	}
	return {
		schemaVersion: 1,
		generatedAt: await env.readGeneratedAt(root),
		gitSha: await env.readGitSha(root),
		packages: collectPackages(root),
		checks,
	};
}

function renderMarkdown(status: ProjectStatus): string {
	const lines = [
		"# Project status",
		"",
		"> Generated by `bun run status:generate` — do not edit by hand.",
		"> Drift check (CI): `bun run status:check`.",
		"",
		`- Commit: \`${status.gitSha}\` (${status.generatedAt})`,
		`- Schema: v${status.schemaVersion}`,
		"",
		"## Packages",
		"",
		"| Package | Version | Classification |",
		"|---|---|---|",
	];
	for (const pkg of status.packages) {
		lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.classification} |`);
	}
	lines.push(
		"",
		"## Checks",
		"",
		"| Check | Command | Exit | Passed | Files |",
		"|---|---|---|---|---|",
	);
	for (const check of status.checks) {
		const passed = check.passed === null ? "—" : String(check.passed);
		const files = check.files === null ? "—" : String(check.files);
		lines.push(
			`| ${check.name} | \`${check.command}\` | ${check.exitCode} | ${passed} | ${files} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

export function renderProjectStatus(status: ProjectStatus): { json: string; markdown: string } {
	return {
		json: `${JSON.stringify(status, null, "\t")}\n`,
		markdown: renderMarkdown(status),
	};
}

/**
 * --check comparison. The recorded status describes the commit that generated it,
 * so the commit that *adds* the file already has a different SHA: comparing gitSha
 * or generatedAt exactly would make the drift check unpassable. Provenance is
 * therefore normalized away; every factual field (versions, classifications,
 * commands, exit codes, counts) must match exactly.
 */
export function statusesEquivalent(a: ProjectStatus, b: ProjectStatus): boolean {
	const normalize = (status: ProjectStatus) => ({ ...status, gitSha: "", generatedAt: "" });
	return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Markdown comparison with only the `- Commit:` provenance line normalized away. */
export function markdownEquivalent(a: string, b: string): boolean {
	const normalize = (markdown: string) =>
		markdown
			.split("\n")
			.map((line) => (line.startsWith("- Commit: ") ? "- Commit: <provenance>" : line))
			.join("\n");
	return normalize(a) === normalize(b);
}

async function main(argv: string[]): Promise<number> {
	const check = argv.includes("--check");
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const status = await collectProjectStatus(root);
	const rendered = renderProjectStatus(status);
	const targets = [
		{ path: join(root, "docs/evidence/status.json"), content: rendered.json },
		{ path: join(root, "docs/evidence/status.md"), content: rendered.markdown },
	];
	if (check) {
		let drifted = false;
		const jsonPath = targets[0]?.path;
		if (!jsonPath || !existsSync(jsonPath)) {
			console.error("[status:check] drift: docs/evidence/status.json missing");
			drifted = true;
		} else {
			try {
				const tracked = JSON.parse(readFileSync(jsonPath, "utf8")) as ProjectStatus;
				if (!statusesEquivalent(tracked, status)) {
					console.error("[status:check] drift: docs/evidence/status.json");
					drifted = true;
				}
			} catch {
				console.error("[status:check] drift: docs/evidence/status.json does not parse");
				drifted = true;
			}
		}
		const mdPath = targets[1]?.path;
		if (!mdPath || !existsSync(mdPath)) {
			console.error("[status:check] drift: docs/evidence/status.md missing");
			drifted = true;
		} else if (!markdownEquivalent(readFileSync(mdPath, "utf8"), rendered.markdown)) {
			console.error("[status:check] drift: docs/evidence/status.md");
			drifted = true;
		}
		if (drifted) {
			console.error("[status:check] tracked status is stale — run `bun run status:generate`");
			return 1;
		}
		console.log("[status:check] up to date");
		return 0;
	}
	for (const target of targets) {
		writeFileSync(target.path, target.content);
		console.log(`[status:generate] wrote ${target.path}`);
	}
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
