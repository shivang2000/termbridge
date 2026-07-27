// Tests for scripts/project-status.ts — deterministic repository status generation.
//
// The collector runs against a fixture workspace (two package manifests) with an
// injected environment (recorded git + check results) so the test never shells out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectProjectStatus,
	markdownEquivalent,
	type ProjectStatus,
	renderProjectStatus,
	type StatusEnvironment,
	statusesEquivalent,
} from "./project-status.ts";

const FIXTURE_SHA = "0123456789abcdef0123456789abcdef01234567";
const FIXTURE_DATE = "2026-07-27T12:00:00.000Z";

const RECORDED_TEST_OUTPUT = [
	" 123 pass",
	" 0 fail",
	" 456 expect() calls",
	"Ran 123 tests across 7 files. [321.00ms]",
].join("\n");

function fixtureEnv(overrides: Partial<StatusEnvironment> = {}): StatusEnvironment {
	return {
		readGitSha: async () => FIXTURE_SHA,
		readGeneratedAt: async () => FIXTURE_DATE,
		runCheck: async (command: string) => {
			if (command === "bun test") {
				return { exitCode: 0, output: RECORDED_TEST_OUTPUT };
			}
			if (command === "bun run lint" || command === "bun run typecheck") {
				return { exitCode: 0, output: "" };
			}
			throw new Error(`unexpected command in fixture env: ${command}`);
		},
		...overrides,
	};
}

function writeManifest(root: string, dir: string, manifest: Record<string, unknown>): void {
	mkdirSync(join(root, "packages", dir), { recursive: true });
	writeFileSync(
		join(root, "packages", dir, "package.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "project-status-"));
	// Deliberately created zeta-first so directory order cannot be relied on.
	writeManifest(root, "zeta", { name: "@fixture/zeta", version: "0.2.0" });
	writeManifest(root, "alpha", { name: "@fixture/alpha", version: "1.2.3", private: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("collectProjectStatus", () => {
	test("collects packages sorted by name with versions and classifications", async () => {
		const status = await collectProjectStatus(root, fixtureEnv());
		expect(status.packages.map((p) => p.name)).toEqual(["@fixture/alpha", "@fixture/zeta"]);
		expect(status.packages).toEqual([
			{ name: "@fixture/alpha", version: "1.2.3", classification: "private" },
			{ name: "@fixture/zeta", version: "0.2.0", classification: "experimental" },
		]);
	});

	test("classifies a non-private stable version as published", async () => {
		writeManifest(root, "stable", { name: "@fixture/stable", version: "2.0.0" });
		const status = await collectProjectStatus(root, fixtureEnv());
		expect(status.packages.find((p) => p.name === "@fixture/stable")?.classification).toBe(
			"published",
		);
	});

	test("records the repository SHA and generation timestamp", async () => {
		const status = await collectProjectStatus(root, fixtureEnv());
		expect(status.schemaVersion).toBe(1);
		expect(status.gitSha).toBe(FIXTURE_SHA);
		expect(status.generatedAt).toBe(FIXTURE_DATE);
	});

	test("records check command metadata and parses test counts", async () => {
		const status = await collectProjectStatus(root, fixtureEnv());
		expect(status.checks).toEqual([
			{ name: "lint", command: "bun run lint", exitCode: 0, passed: null, files: null },
			{ name: "typecheck", command: "bun run typecheck", exitCode: 0, passed: null, files: null },
			{ name: "test", command: "bun test", exitCode: 0, passed: 123, files: 7 },
		]);
	});

	test("propagates failing exit codes and null counts for unparseable output", async () => {
		const env = fixtureEnv({
			runCheck: async () => ({ exitCode: 1, output: "something exploded" }),
		});
		const status = await collectProjectStatus(root, env);
		for (const check of status.checks) {
			expect(check.exitCode).toBe(1);
		}
		const testCheck = status.checks.find((c) => c.name === "test");
		expect(testCheck?.passed).toBeNull();
		expect(testCheck?.files).toBeNull();
	});

	test("is deterministic for identical inputs", async () => {
		const a = await collectProjectStatus(root, fixtureEnv());
		const b = await collectProjectStatus(root, fixtureEnv());
		expect(a).toEqual(b);
	});
});

describe("renderProjectStatus", () => {
	let status: ProjectStatus;

	beforeEach(async () => {
		status = await collectProjectStatus(root, fixtureEnv());
	});

	test("json round-trips the status exactly", () => {
		const { json } = renderProjectStatus(status);
		expect(JSON.parse(json)).toEqual(status);
	});

	test("markdown is stable across renders", () => {
		const first = renderProjectStatus(status).markdown;
		const second = renderProjectStatus(status).markdown;
		expect(first).toBe(second);
	});

	test("markdown records the sha, package table, and check table", () => {
		const { markdown } = renderProjectStatus(status);
		expect(markdown).toContain(FIXTURE_SHA);
		expect(markdown).toContain("| @fixture/alpha | 1.2.3 | private |");
		expect(markdown).toContain("| @fixture/zeta | 0.2.0 | experimental |");
		expect(markdown).toContain("| test | `bun test` | 0 | 123 | 7 |");
		expect(markdown.indexOf("@fixture/alpha")).toBeLessThan(markdown.indexOf("@fixture/zeta"));
	});

	test("markdown warns instead of claiming success when a check failed", () => {
		const failed: ProjectStatus = {
			...status,
			checks: status.checks.map((c) => (c.name === "test" ? { ...c, exitCode: 1 } : c)),
		};
		const { markdown } = renderProjectStatus(failed);
		expect(markdown).toContain("| test | `bun test` | 1 |");
	});
});

describe("status equivalence for --check", () => {
	test("statusesEquivalent ignores provenance but compares facts", async () => {
		const a = await collectProjectStatus(root, fixtureEnv());
		const provenanceShifted: ProjectStatus = {
			...a,
			gitSha: "ffffffffffffffffffffffffffffffffffffffff",
			generatedAt: "2026-07-28T00:00:00.000Z",
		};
		expect(statusesEquivalent(a, provenanceShifted)).toBe(true);
		const factShifted: ProjectStatus = {
			...a,
			packages: a.packages.map((p) =>
				p.name === "@fixture/alpha" ? { ...p, version: "9.9.9" } : p,
			),
		};
		expect(statusesEquivalent(a, factShifted)).toBe(false);
	});

	test("markdownEquivalent ignores only the commit provenance line", async () => {
		const a = renderProjectStatus(await collectProjectStatus(root, fixtureEnv())).markdown;
		const provenanceShifted = a.replace(/- Commit: .+/, "- Commit: `deadbeef` (later)");
		expect(markdownEquivalent(a, provenanceShifted)).toBe(true);
		const factShifted = a.replace("1.2.3", "9.9.9");
		expect(markdownEquivalent(a, factShifted)).toBe(false);
	});
});
