// Tests for scripts/gate-check.ts — executable phase gates.
//
// Mechanics are tested against synthetic fixtures with an injected exec; no real
// repository commands run here. One integration test reads the real plan file and
// cross-checks the checkbox scan against an independent count.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Criterion,
	evaluateCriterion,
	extractPhaseSection,
	type GateContext,
	readGateEvidence,
	runGateCheck,
	validateGateEvidence,
} from "./gate-check.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function okExec(): GateContext["exec"] {
	return async () => ({ exitCode: 0, output: "" });
}

function failExec(output = "boom"): GateContext["exec"] {
	return async () => ({ exitCode: 1, output });
}

function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		phase: "0",
		recordedAt: "2026-07-27T12:00:00.000Z",
		gitSha: SHA,
		reviewerSignOff: null,
		criteria: [{ name: "suite green", command: "bun test", exitCode: 0 }],
		...overrides,
	};
}

function gateMd(record: Record<string, unknown>): string {
	return ["# Phase gate evidence", "", "```json", JSON.stringify(record, null, 2), "```", ""].join(
		"\n",
	);
}

describe("extractPhaseSection", () => {
	const plan = [
		"# Plan",
		"",
		"## Phase 0 — Truth",
		"",
		"- [x] done",
		"- [ ] open",
		"",
		"## Phase 1 — Durable",
		"",
		"- [x] done",
		"",
		"## Program execution and review policy",
	].join("\n");

	test("slices one phase up to the next level-2 heading", () => {
		const section = extractPhaseSection(plan, "0");
		expect(section).toContain("- [ ] open");
		expect(section).not.toContain("## Phase 1");
	});

	test("maps release to the phase 5 section", () => {
		const withFive = plan.replace("## Phase 1 — Durable", "## Phase 5 — Local product");
		expect(extractPhaseSection(withFive, "release")).toContain("## Phase 5");
	});

	test("throws when the phase heading is absent", () => {
		expect(() => extractPhaseSection(plan, "4c")).toThrow(/phase heading/i);
	});
});

describe("validateGateEvidence", () => {
	test("accepts a valid record", () => {
		expect(validateGateEvidence(validEvidence())).toEqual([]);
	});

	test("rejects missing required fields, bad sha, bad phase, and unknown keys", () => {
		const missing = validateGateEvidence({ schemaVersion: 1 });
		expect(missing.join("\n")).toMatch(/phase/);
		expect(validateGateEvidence(validEvidence({ gitSha: "abc" })).join("\n")).toMatch(/gitSha/);
		expect(validateGateEvidence(validEvidence({ phase: "9" })).join("\n")).toMatch(/phase/);
		expect(validateGateEvidence(validEvidence({ extra: true })).join("\n")).toMatch(/extra/);
		expect(validateGateEvidence(validEvidence({ criteria: [{ name: "x" }] })).join("\n")).toMatch(
			/exitCode/,
		);
		expect(validateGateEvidence(validEvidence({ criteria: [] })).join("\n")).toMatch(/criteria/);
	});
});

describe("readGateEvidence", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "gate-check-"));
		mkdirSync(join(root, "docs/evidence/autonomous-local/phase-0"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("parses the fenced json record and enforces the phase", () => {
		writeFileSync(
			join(root, "docs/evidence/autonomous-local/phase-0/gate.md"),
			gateMd(validEvidence()),
		);
		const result = readGateEvidence(root, "0");
		expect(result.errors).toEqual([]);
		expect(result.record?.gitSha).toBe(SHA);
	});

	test("fails when the file, the json block, or the phase match is missing", () => {
		expect(readGateEvidence(root, "0").errors.join("\n")).toMatch(/gate\.md/);
		writeFileSync(join(root, "docs/evidence/autonomous-local/phase-0/gate.md"), "no json here\n");
		expect(readGateEvidence(root, "0").errors.join("\n")).toMatch(/json/);
		writeFileSync(
			join(root, "docs/evidence/autonomous-local/phase-0/gate.md"),
			gateMd(validEvidence({ phase: "1" })),
		);
		expect(readGateEvidence(root, "0").errors.join("\n")).toMatch(/phase/);
	});
});
describe("evaluateCriterion", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "gate-check-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const ctx = (exec: GateContext["exec"]): GateContext => ({ root, exec });

	test("command criterion follows the exit code", async () => {
		const criterion: Criterion = { kind: "command", name: "suite", command: "bun test" };
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(true);
		const failed = await evaluateCriterion(criterion, ctx(failExec("1 fail")));
		expect(failed.ok).toBe(false);
		expect(failed.detail).toContain("exit 1");
	});

	test("files criterion requires existence and content patterns", async () => {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs/a.md"), "classification: deferred\nowner: maintainer\n");
		const criterion: Criterion = {
			kind: "files",
			name: "evidence",
			files: [{ path: "docs/a.md", contains: ["classification:", "owner:", "reason:"] }],
		};
		const result = await evaluateCriterion(criterion, ctx(okExec()));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("reason:");
		writeFileSync(
			join(root, "docs/a.md"),
			"classification: deferred\nowner: maintainer\nreason: none\n",
		);
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(true);
	});

	test("line-count criterion counts pattern matches", async () => {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs/DECISIONS.md"), "## V2-D1 a\n## V2-D2 b\n## other\n");
		const criterion: Criterion = {
			kind: "line-count",
			name: "adrs",
			path: "docs/DECISIONS.md",
			pattern: "^## V2-D([1-9]|1[0-7]) ",
			count: 17,
		};
		const result = await evaluateCriterion(criterion, ctx(okExec()));
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("2");
	});

	test("absent criterion fails when the forbidden pattern appears", async () => {
		mkdirSync(join(root, "packages/driver-x/src"), { recursive: true });
		writeFileSync(join(root, "packages/driver-x/src/a.ts"), 'import "forge-github";\n');
		const criterion: Criterion = {
			kind: "absent",
			name: "no forge import",
			dirs: ["packages/driver-x/src"],
			pattern: "forge-github",
		};
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(false);
		writeFileSync(join(root, "packages/driver-x/src/a.ts"), 'import "nothing";\n');
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(true);
	});

	test("hash-link criterion ties the spike hash into the frozen sources", async () => {
		mkdirSync(join(root, "docs/evidence"), { recursive: true });
		mkdirSync(join(root, "packages/control-plane/src"), { recursive: true });
		const hash = "a".repeat(64);
		writeFileSync(join(root, "docs/evidence/spike.md"), `driver_event_schema_hash: ${hash}\n`);
		const criterion: Criterion = {
			kind: "hash-link",
			name: "spike hash incorporated",
			evidencePath: "docs/evidence/spike.md",
			field: "driver_event_schema_hash",
			searchDirs: ["packages/control-plane/src"],
		};
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(false);
		writeFileSync(
			join(root, "packages/control-plane/src/domain.ts"),
			`// DriverEvent freeze incorporates opencode spike ${hash}\n`,
		);
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(true);
	});

	test("file-one-of criterion accepts any fully matching group", async () => {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs/h.md"), "classification: deferred\nowner: m\nreason: r\n");
		const criterion: Criterion = {
			kind: "file-one-of",
			name: "hermes evidence or defer",
			path: "docs/h.md",
			groups: [
				{ label: "live run", contains: ["classification: live", "command:"] },
				{ label: "defer", contains: ["classification: deferred", "owner:", "reason:"] },
			],
		};
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(true);
		writeFileSync(join(root, "docs/h.md"), "nothing useful\n");
		expect((await evaluateCriterion(criterion, ctx(okExec()))).ok).toBe(false);
	});
});

describe("runGateCheck", () => {
	test("reports checkbox, evidence, and criteria results against the real plan", async () => {
		const root = join(import.meta.dir, "..");
		const result = await runGateCheck("0", { root, exec: okExec() });
		expect(result.results.length).toBeGreaterThan(5);
		for (const entry of result.results) {
			expect(entry.name.length).toBeGreaterThan(0);
			expect(entry.detail.length).toBeGreaterThan(0);
		}
		// Cross-check the checkbox scan against an independent count of the real plan.
		const plan = await Bun.file(
			join(root, "docs/superpowers/plans/2026-07-25-autonomous-local.md"),
		).text();
		const unchecked = extractPhaseSection(plan, "0")
			.split("\n")
			.filter((line) => line.startsWith("- [ ]")).length;
		const checkboxResult = result.results.find((r) => r.name.includes("checkbox"));
		expect(checkboxResult).toBeDefined();
		expect(checkboxResult?.ok).toBe(unchecked === 0);
		// Evidence does not exist yet, so the gate cannot pass right now.
		expect(result.ok).toBe(false);
	});

	test("rejects an unknown phase", async () => {
		await expect(
			runGateCheck("9" as never, { root: import.meta.dir, exec: okExec() }),
		).rejects.toThrow(/phase/);
	});
});
