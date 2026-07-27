// Benchmark manifest gate (Phase 0 Task 3, gate criterion P0.6).
//
// Two layers, both executable:
//   1. JSON Schema (manifest.schema.json) — shape, enums, pinning patterns.
//   2. Cross-reference rules below — the things JSON Schema cannot say: unique
//      fixtures, dangling fixture references, all 18 critical scenarios claimed,
//      all 10 grader categories covered. The stable gate's "every critical case
//      is 3/3" is uncomputable if a scenario can silently go unclaimed.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";

const DIR = join(import.meta.dir);
const SCHEMA_PATH = join(DIR, "manifest.schema.json");
const MANIFEST_PATH = join(DIR, "manifest.json");

export const CRITICAL_SCENARIOS = [
	"plan_rejection",
	"stale_approval",
	"attempted_planning_mutation",
	"permission_scope",
	"human_takeover_and_return",
	"daemon_death_at_operation_boundary",
	"secret_canary",
	"auth_expiry",
	"tracker_revocation",
	"duplicate_webhook",
	"out_of_order_webhook",
	"rate_limit",
	"lost_event_consumer",
	"interrupted_dirty_worktree",
	"blocking_review",
	"uncertain_push_pr_creation",
	"branch_tampering",
	"runtime_conflict",
] as const;

export const GRADER_CATEGORIES = [
	"localized_fix",
	"multi_file_feature",
	"api_change",
	"migration",
	"frontend_e2e",
	"configuration_change",
	"diagnosis",
	"security_validation",
	"clarification",
	"intentionally_unsafe_request",
] as const;

const SHA = "a".repeat(40);
const HASH = "b".repeat(64);
const IMAGE = `oven/bun@sha256:${"c".repeat(64)}`;

function makeFixture(id: string): Record<string, unknown> {
	return {
		id,
		url: `https://github.com/example/${id}`,
		commit_sha: SHA,
		license: "MIT",
		content_sha256: HASH,
		image: IMAGE,
	};
}

function makeCase(index: number): Record<string, unknown> {
	return {
		id: `case-${String(index + 1).padStart(2, "0")}`,
		title: `synthetic case ${index + 1}`,
		fixture_id: `f${(index % 4) + 1}`,
		grader_category: GRADER_CATEGORIES[index % GRADER_CATEGORIES.length],
		critical_scenario: index < CRITICAL_SCENARIOS.length ? CRITICAL_SCENARIOS[index] : null,
		task: {
			statement: "do the thing",
			acceptance_criteria: ["the thing is done"],
			setup: "bun install",
		},
		runtime: {
			cli_targets: ["claude-code", "opencode"],
			cli_binary: "claude",
			cli_build: "1.0.0",
			adapter_version: "0.0.0",
			adapter_schema_hash: HASH,
			model: "default",
			settings: {},
			termbridge_sha: SHA,
			environment_provider: "docker",
			network_policy: "allowlist",
		},
		intervention: { kind: "none", injection_point: "", script: "" },
		grader: { kind: "command", command: "bun test", expected: "exit 0" },
		time_limit_seconds: 1800,
		cost_ceiling_usd: 5,
		rubrics: { success: ["grader exits zero"], policy_violations: [] },
		evidence_required: ["transcript", "diff"],
		budgets: { elapsed_seconds_max: 3600, usage_proxy: "tokens<=250000" },
		infrastructure_invalid_classification: "retryable",
	};
}

function makeValidManifest(): Record<string, unknown> {
	return {
		schema_version: 1,
		budget: {
			per_cli_wall_clock_minutes: 1800,
			per_cli_cost_ceiling_usd: 150,
			infrastructure_invalid_rerun_rate_cap: 0.1,
		},
		run_modes: {
			stable_matrix: "20 cases x 3 clean attempts x 2 CLIs",
			latest_upstream_canary: "reported separately; never auto-expands the supported range",
			nightly_smoke: "one attempt per case; never a stable-matrix substitute",
		},
		fixtures: [makeFixture("f1"), makeFixture("f2"), makeFixture("f3"), makeFixture("f4")],
		cases: Array.from({ length: 20 }, (_, i) => makeCase(i)),
	};
}

function loadSchema(): ReturnType<Ajv["compile"]> {
	const ajv = new Ajv({ allErrors: true, strict: true });
	return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
}

/** Rules JSON Schema cannot express. Returns a list of violations (empty = valid). */
export function validateCrossRefs(data: unknown): string[] {
	const violations: string[] = [];
	if (typeof data !== "object" || data === null) return ["manifest is not an object"];
	const manifest = data as {
		fixtures?: Array<{ id?: unknown }>;
		cases?: Array<{ fixture_id?: unknown; grader_category?: unknown; critical_scenario?: unknown }>;
	};
	const fixtureIds = (manifest.fixtures ?? []).map((f) => f.id);
	const uniqueFixtures = new Set(fixtureIds);
	if (uniqueFixtures.size !== fixtureIds.length) violations.push("fixture ids are not unique");
	if (uniqueFixtures.size < 4) violations.push("fewer than four unique fixtures");
	const cases = manifest.cases ?? [];
	for (const c of cases) {
		if (typeof c.fixture_id === "string" && !uniqueFixtures.has(c.fixture_id)) {
			violations.push(`dangling fixture_id: ${c.fixture_id}`);
		}
	}
	const claimed = new Set(cases.map((c) => c.critical_scenario).filter((s) => s !== null));
	for (const scenario of CRITICAL_SCENARIOS) {
		if (!claimed.has(scenario)) violations.push(`unclaimed critical_scenario: ${scenario}`);
	}
	const categories = new Set(cases.map((c) => c.grader_category));
	for (const category of GRADER_CATEGORIES) {
		if (!categories.has(category)) violations.push(`uncovered grader_category: ${category}`);
	}
	return violations;
}

function expectInvalid(manifest: Record<string, unknown>, label: string): void {
	const validate = loadSchema();
	const schemaOk = validate(manifest);
	const crossRefViolations = validateCrossRefs(manifest);
	expect(
		schemaOk === false || crossRefViolations.length > 0,
		`${label}: expected schema or cross-ref rejection (schema errors: ${JSON.stringify(validate.errors)}, cross-ref: ${crossRefViolations.join("; ")})`,
	).toBe(true);
}

/** Checked element access — keeps the noNonNullAssertion lint at zero. */
function item(
	manifest: Record<string, unknown>,
	key: string,
	index: number,
): Record<string, unknown> {
	const list = manifest[key] as unknown[];
	const value = list[index];
	if (typeof value !== "object" || value === null) throw new Error(`no ${key}[${index}]`);
	return value as Record<string, unknown>;
}

describe("manifest schema", () => {
	test("a complete valid manifest passes schema and cross-refs", () => {
		const manifest = makeValidManifest();
		const validate = loadSchema();
		expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
		expect(validateCrossRefs(manifest)).toEqual([]);
	});

	test("rejects unknown keys at top level and inside a case", () => {
		expectInvalid({ ...makeValidManifest(), bogus: true }, "unknown top-level key");
		const manifest = makeValidManifest();
		item(manifest, "cases", 0).bogus = true;
		expectInvalid(manifest, "unknown case key");
	});

	test("rejects missing license, non-40-char SHA, bad content hash, unpinned image", () => {
		const noLicense = makeValidManifest();
		delete item(noLicense, "fixtures", 0).license;
		expectInvalid(noLicense, "missing license");

		const badSha = makeValidManifest();
		item(badSha, "fixtures", 0).commit_sha = "abc123";
		expectInvalid(badSha, "non-40-char SHA");

		const badHash = makeValidManifest();
		item(badHash, "fixtures", 0).content_sha256 = "deadbeef";
		expectInvalid(badHash, "short content hash");

		const unpinned = makeValidManifest();
		item(unpinned, "fixtures", 0).image = "oven/bun:latest";
		expectInvalid(unpinned, "unpinned image tag");
	});

	test("rejects missing deterministic grader and missing cost ceiling", () => {
		const noGrader = makeValidManifest();
		delete item(noGrader, "cases", 0).grader;
		expectInvalid(noGrader, "missing grader");

		const noCeiling = makeValidManifest();
		delete item(noCeiling, "cases", 0).cost_ceiling_usd;
		expectInvalid(noCeiling, "missing cost ceiling");
	});

	test("rejects fewer than four unique fixtures and duplicate fixture ids", () => {
		const three = makeValidManifest();
		three.fixtures = (three.fixtures as unknown[]).slice(0, 3);
		(three.cases as Array<Record<string, unknown>>).forEach((c, i) => {
			c.fixture_id = `f${(i % 3) + 1}`;
		});
		expectInvalid(three, "three fixtures");

		const dup = makeValidManifest();
		item(dup, "fixtures", 1).id = "f1";
		expectInvalid(dup, "duplicate fixture id");
	});

	test("rejects fewer than 20 cases", () => {
		const manifest = makeValidManifest();
		manifest.cases = (manifest.cases as unknown[]).slice(0, 19);
		expectInvalid(manifest, "19 cases");
	});

	test("rejects an unclaimed critical scenario", () => {
		const manifest = makeValidManifest();
		item(manifest, "cases", 0).critical_scenario = null;
		expectInvalid(manifest, "unclaimed scenario");
	});

	test("rejects an uncovered grader category", () => {
		const manifest = makeValidManifest();
		for (const c of manifest.cases as Array<Record<string, unknown>>) {
			if (c.grader_category === "diagnosis") c.grader_category = "localized_fix";
		}
		expectInvalid(manifest, "uncovered category");
	});

	test("rejects a dangling fixture reference", () => {
		const manifest = makeValidManifest();
		item(manifest, "cases", 0).fixture_id = "nope";
		expectInvalid(manifest, "dangling fixture");
	});

	test("rejects invalid enum values", () => {
		const badScenario = makeValidManifest();
		item(badScenario, "cases", 0).critical_scenario = "invented";
		expectInvalid(badScenario, "bad scenario enum");

		const badCategory = makeValidManifest();
		item(badCategory, "cases", 0).grader_category = "invented";
		expectInvalid(badCategory, "bad category enum");
	});
});

describe("the committed manifest", () => {
	test("manifest.json validates against the schema and cross-refs", () => {
		const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
		const validate = loadSchema();
		expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
		expect(validateCrossRefs(manifest)).toEqual([]);
	});

	test("every fixture carries a real 40-char SHA, SHA-256, SPDX license, and digest", () => {
		const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
			fixtures: Array<Record<string, string>>;
		};
		for (const fixture of manifest.fixtures) {
			expect(fixture.commit_sha).toMatch(/^[0-9a-f]{40}$/);
			expect(fixture.content_sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(fixture.license.length).toBeGreaterThan(0);
			expect(fixture.image).toMatch(/@sha256:[0-9a-f]{64}$/);
		}
	});
});
