// Executable phase gates (Autonomous Local, Phase 0 Task 1).
//
// Every phase gate in docs/superpowers/plans/2026-07-25-autonomous-local.md names
// observable criteria; this script makes them runnable:
//   bun scripts/gate-check.ts --phase <0|1|2|3|4a|4b|4c|release>
//
// A phase passes only when:
//   (a) every `- [ ]` checkbox inside that phase's plan section is checked;
//   (b) docs/evidence/autonomous-local/<phase>/gate.md exists and its fenced json
//       record validates against gate-evidence.schema.json (phase evidence is
//       prose for humans plus a machine-checkable record — never prose alone);
//   (c) every criterion encoded from the phase's gate section exits clean.
//
// Gates fail closed: a missing file, a missing credential, or an unparseable
// result is a failing criterion with a named reason, never a silent skip.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PhaseId = "0" | "1" | "2" | "3" | "4a" | "4b" | "4c" | "release";

export const PHASE_IDS: readonly PhaseId[] = ["0", "1", "2", "3", "4a", "4b", "4c", "release"];

export type Criterion =
	| { kind: "command"; name: string; command: string }
	| { kind: "files"; name: string; files: Array<{ path: string; contains?: string[] }> }
	| {
			kind: "file-one-of";
			name: string;
			path: string;
			groups: Array<{ label: string; contains: string[] }>;
	  }
	| { kind: "line-count"; name: string; path: string; pattern: string; count: number }
	| { kind: "hash-link"; name: string; evidencePath: string; field: string; searchDirs: string[] }
	| { kind: "absent"; name: string; dirs: string[]; pattern: string }
	| { kind: "git-tracked"; name: string; paths: string[] };

export interface ExecResult {
	exitCode: number;
	output: string;
}

export interface GateContext {
	root: string;
	exec(command: string, cwd: string): Promise<ExecResult>;
}

export interface CriterionResult {
	name: string;
	ok: boolean;
	detail: string;
}

const PLAN_PATH = "docs/superpowers/plans/2026-07-25-autonomous-local.md";

const PHASE_HEADINGS: Record<PhaseId, RegExp> = {
	"0": /^## Phase 0 —/m,
	"1": /^## Phase 1 —/m,
	"2": /^## Phase 2 —/m,
	"3": /^## Phase 3 —/m,
	"4a": /^## Phase 4A —/m,
	"4b": /^## Phase 4B —/m,
	"4c": /^## Phase 4C —/m,
	// The stable/release gate lives inside the Phase 5 section.
	release: /^## Phase 5 —/m,
};

function evidenceDir(phase: PhaseId): string {
	return phase === "release" ? "release" : `phase-${phase}`;
}

/** Slice the phase's section out of the plan: from its `## Phase` heading to the next `## `. */
export function extractPhaseSection(plan: string, phase: PhaseId): string {
	const heading = PHASE_HEADINGS[phase];
	const match = heading.exec(plan);
	if (!match) throw new Error(`phase heading not found in plan for phase ${phase}`);
	const start = match.index;
	const rest = plan.slice(start + match[0].length);
	const next = /^## /m.exec(rest);
	return next ? plan.slice(start, start + match[0].length + next.index) : plan.slice(start);
}

function countUnchecked(section: string): number {
	return section.split("\n").filter((line) => line.startsWith("- [ ]")).length;
}

// --- gate evidence ------------------------------------------------------------

const EVIDENCE_PHASES = ["0", "1", "2", "3", "4a", "4b", "4c", "release"] as const;
const EVIDENCE_KEYS = new Set([
	"schemaVersion",
	"phase",
	"recordedAt",
	"gitSha",
	"reviewerSignOff",
	"criteria",
]);
const CRITERION_KEYS = new Set(["name", "command", "exitCode", "evidencePath", "notes"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hand-rolled validator mirroring gate-evidence.schema.json. The schema file is
 * the declarative contract; this function is its executable form (the repo has no
 * JSON Schema runtime dependency at Phase 0).
 */
export function validateGateEvidence(data: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(data)) return ["evidence record must be an object"];
	for (const key of Object.keys(data)) {
		if (!EVIDENCE_KEYS.has(key)) errors.push(`unknown top-level key: ${key}`);
	}
	if (data.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (typeof data.phase !== "string" || !EVIDENCE_PHASES.includes(data.phase as PhaseId)) {
		errors.push(`phase must be one of ${EVIDENCE_PHASES.join(", ")}`);
	}
	if (typeof data.recordedAt !== "string" || Number.isNaN(Date.parse(data.recordedAt))) {
		errors.push("recordedAt must be an ISO timestamp string");
	}
	if (typeof data.gitSha !== "string" || !/^[0-9a-f]{40}$/.test(data.gitSha)) {
		errors.push("gitSha must be a 40-character lowercase hex SHA");
	}
	if (
		"reviewerSignOff" in data &&
		data.reviewerSignOff !== null &&
		typeof data.reviewerSignOff !== "string"
	) {
		errors.push("reviewerSignOff must be a string or null");
	}
	if (!Array.isArray(data.criteria) || data.criteria.length === 0) {
		errors.push("criteria must be a non-empty array");
	} else {
		data.criteria.forEach((item, index) => {
			if (!isRecord(item)) {
				errors.push(`criteria[${index}] must be an object`);
				return;
			}
			for (const key of Object.keys(item)) {
				if (!CRITERION_KEYS.has(key)) errors.push(`criteria[${index}] unknown key: ${key}`);
			}
			if (typeof item.name !== "string" || item.name.length === 0) {
				errors.push(`criteria[${index}].name must be a non-empty string`);
			}
			if (typeof item.command !== "string" || item.command.length === 0) {
				errors.push(`criteria[${index}].command must be a non-empty string`);
			}
			if (typeof item.exitCode !== "number" || !Number.isInteger(item.exitCode)) {
				errors.push(`criteria[${index}].exitCode must be an integer`);
			}
		});
	}
	return errors;
}

export interface GateEvidenceRead {
	record: Record<string, unknown> | null;
	errors: string[];
}

/** Read and validate the fenced json record inside the phase's gate.md. */
export function readGateEvidence(root: string, phase: PhaseId): GateEvidenceRead {
	const path = join(root, "docs/evidence/autonomous-local", evidenceDir(phase), "gate.md");
	if (!existsSync(path)) {
		return { record: null, errors: [`missing evidence file: ${path}`] };
	}
	const content = readFileSync(path, "utf8");
	const block = /```json\s*\n([\s\S]*?)\n```/.exec(content);
	if (!block?.[1]) {
		return { record: null, errors: [`${path} contains no fenced json record`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(block[1]);
	} catch (error) {
		return {
			record: null,
			errors: [`${path} json record does not parse: ${(error as Error).message}`],
		};
	}
	const errors = validateGateEvidence(parsed);
	if (isRecord(parsed) && parsed.phase !== phase) {
		errors.push(`evidence phase ${String(parsed.phase)} does not match requested phase ${phase}`);
	}
	return { record: isRecord(parsed) ? parsed : null, errors };
}

// --- criterion evaluation -------------------------------------------------------

/** Content patterns compile case-insensitive + multiline: evidence prose varies in case. */
function containsAll(content: string, patterns: string[]): string[] {
	return patterns.filter((pattern) => !new RegExp(pattern, "im").test(content));
}

function listFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".git") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...listFilesRecursive(path));
		else out.push(path);
	}
	return out;
}

function summarize(output: string): string {
	const lines = output.trim().split("\n").filter(Boolean);
	return lines.length === 0 ? "no output" : (lines.at(-1) ?? "").slice(0, 200);
}

export async function evaluateCriterion(
	criterion: Criterion,
	ctx: GateContext,
): Promise<CriterionResult> {
	switch (criterion.kind) {
		case "command": {
			const result = await ctx.exec(criterion.command, ctx.root);
			return {
				name: criterion.name,
				ok: result.exitCode === 0,
				detail:
					result.exitCode === 0
						? `\`${criterion.command}\` exit 0`
						: `\`${criterion.command}\` exit ${result.exitCode} — ${summarize(result.output)}`,
			};
		}
		case "files": {
			const problems: string[] = [];
			for (const file of criterion.files) {
				const path = join(ctx.root, file.path);
				if (!existsSync(path)) {
					problems.push(`missing ${file.path}`);
					continue;
				}
				const missing = containsAll(readFileSync(path, "utf8"), file.contains ?? []);
				for (const pattern of missing) problems.push(`${file.path} lacks /${pattern}/`);
			}
			return {
				name: criterion.name,
				ok: problems.length === 0,
				detail:
					problems.length === 0 ? "all files present with required fields" : problems.join("; "),
			};
		}
		case "file-one-of": {
			const path = join(ctx.root, criterion.path);
			if (!existsSync(path)) {
				return { name: criterion.name, ok: false, detail: `missing ${criterion.path}` };
			}
			const content = readFileSync(path, "utf8");
			const misses = criterion.groups.map((group) => ({
				label: group.label,
				missing: containsAll(content, group.contains),
			}));
			const matched = misses.find((m) => m.missing.length === 0);
			return {
				name: criterion.name,
				ok: matched !== undefined,
				detail: matched
					? `matches "${matched.label}"`
					: misses.map((m) => `"${m.label}" lacks ${m.missing.join(", ")}`).join("; "),
			};
		}
		case "line-count": {
			const path = join(ctx.root, criterion.path);
			if (!existsSync(path)) {
				return { name: criterion.name, ok: false, detail: `missing ${criterion.path}` };
			}
			const pattern = new RegExp(criterion.pattern);
			const count = readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => pattern.test(line)).length;
			return {
				name: criterion.name,
				ok: count === criterion.count,
				detail: `found ${count} matches of /${criterion.pattern}/, expected ${criterion.count}`,
			};
		}
		case "hash-link": {
			const path = join(ctx.root, criterion.evidencePath);
			if (!existsSync(path)) {
				return { name: criterion.name, ok: false, detail: `missing ${criterion.evidencePath}` };
			}
			const field = new RegExp(`${criterion.field}:\\s*([0-9a-f]{64})`, "i").exec(
				readFileSync(path, "utf8"),
			);
			if (!field?.[1]) {
				return {
					name: criterion.name,
					ok: false,
					detail: `${criterion.evidencePath} records no ${criterion.field}: <sha256>`,
				};
			}
			const hash = field[1].toLowerCase();
			const files = criterion.searchDirs.flatMap((dir) => listFilesRecursive(join(ctx.root, dir)));
			const hit = files.find((file) => readFileSync(file, "utf8").includes(hash));
			return {
				name: criterion.name,
				ok: hit !== undefined,
				detail: hit
					? `spike hash incorporated in ${hit}`
					: `spike hash ${hash.slice(0, 12)}… not referenced under ${criterion.searchDirs.join(", ")}`,
			};
		}
		case "absent": {
			const pattern = new RegExp(criterion.pattern, "i");
			const offenders: string[] = [];
			for (const dir of criterion.dirs) {
				for (const file of listFilesRecursive(join(ctx.root, dir))) {
					if (pattern.test(readFileSync(file, "utf8"))) offenders.push(file);
				}
			}
			return {
				name: criterion.name,
				ok: offenders.length === 0,
				detail:
					offenders.length === 0
						? `no match for /${criterion.pattern}/ under ${criterion.dirs.join(", ")}`
						: `forbidden /${criterion.pattern}/ in ${offenders.join(", ")}`,
			};
		}
		case "git-tracked": {
			const result = await ctx.exec(`git ls-files -- ${criterion.paths.join(" ")}`, ctx.root);
			const tracked = new Set(result.output.split("\n").map((line) => line.trim()));
			const missing = criterion.paths.filter((path) => !tracked.has(path));
			return {
				name: criterion.name,
				ok: missing.length === 0,
				detail: missing.length === 0 ? "all paths tracked" : `untracked: ${missing.join(", ")}`,
			};
		}
	}
}

// --- gate definitions -----------------------------------------------------------
//
// One entry per numbered criterion in the plan's phase-gate sections. Criterion 1
// of every phase ("all task checkboxes checked") and the gate.md evidence check
// are structural and run in runGateCheck, so they are not repeated here.

const PHASE_0: Criterion[] = [
	{
		kind: "git-tracked",
		name: "P0.2 V2 authority documents committed",
		paths: [
			"docs/ROADMAP-V2.md",
			"docs/superpowers/specs/2026-07-25-autonomous-local-design.md",
			"docs/superpowers/plans/2026-07-25-autonomous-local.md",
			"docs/research/2026-07-24-jira-linear-github-autonomous-workflows.md",
			"docs/research/2026-07-11-roadmap-v2-durable-platform-architecture.md",
			"docs/research/2026-07-11-cli-adapters-codex-opencode.md",
			"docs/DECISIONS.md",
			"CLAUDE.md",
		],
	},
	{ kind: "command", name: "P0.3 generated status is current", command: "bun run status:check" },
	{
		kind: "line-count",
		name: "P0.4 all 17 V2 ADRs accepted",
		path: "docs/DECISIONS.md",
		pattern: "^## V2-D([1-9]|1[0-7]) ",
		count: 17,
	},
	{
		kind: "files",
		name: "P0.4b V2-D2 supersedes legacy D3",
		files: [{ path: "docs/DECISIONS.md", contains: ["^## V2-D2 ", "supersed", "D3"] }],
	},
	{
		kind: "files",
		name: "P0.5 ARCHITECTURE.md reflects V2 layering",
		files: [
			{
				path: "docs/ARCHITECTURE.md",
				contains: [
					"^## Packages$",
					"^## Layering$",
					"^## Control plane$",
					"^## Drivers$",
					"^## Trackers$",
					"^## Forge$",
				],
			},
		],
	},
	{
		kind: "command",
		name: "P0.6 benchmark manifest schema passes",
		command: "bun test benchmarks/autonomous-local/manifest.schema.test.ts",
	},
	{
		kind: "files",
		name: "P0.7 sandbox classifications recorded",
		files: [
			{
				path: "docs/evidence/autonomous-local/phase-0/daytona-live.md",
				contains: ["classification", "owner", "reason", "next review date"],
			},
			{
				path: "docs/evidence/autonomous-local/phase-0/cloudflare-live.md",
				contains: ["classification", "owner", "reason", "next review date"],
			},
		],
	},
	{
		kind: "file-one-of",
		name: "P0.8 hermes demo evidence or formal defer",
		path: "docs/evidence/autonomous-local/phase-0/hermes-demo.md",
		groups: [
			{ label: "live run", contains: ["command", "timestamp", "hermes"] },
			{
				label: "formal defer",
				contains: ["classification: deferred", "owner:", "reason:", "next_review_date:"],
			},
		],
	},
	{
		kind: "files",
		name: "P0.9 spike evidence files exist",
		files: [
			{ path: "docs/evidence/autonomous-local/phase-0/opencode-spike.md" },
			{ path: "docs/evidence/autonomous-local/phase-0/claude-structured-surface.md" },
		],
	},
	{
		kind: "hash-link",
		name: "P0.9b frozen DriverEvent schema hash matches the opencode spike",
		evidencePath: "docs/evidence/autonomous-local/phase-0/opencode-spike.md",
		field: "driver_event_schema_hash",
		searchDirs: ["packages/control-plane/src"],
	},
	{
		kind: "files",
		name: "P0.10 threat model covers all seven surfaces",
		files: [
			{
				path: "docs/security/threat-model.md",
				contains: [
					"^## Local daemon$",
					"^## CLI adapter$",
					"^## Sandbox$",
					"^## Git$",
					"^## Forge$",
					"^## Browser$",
					"^## Supply chain$",
				],
			},
		],
	},
	{
		kind: "files",
		name: "P0.11 install smoke reproducibility recorded",
		files: [
			{
				path: "docs/evidence/autonomous-local/phase-0/install-smoke.md",
				contains: ["local", "docker", "e2b", "exit code", "timestamp"],
			},
		],
	},
	{
		kind: "command",
		name: "P0.12 existing suite remains green",
		command: "bun run lint && bun run typecheck && bun test",
	},
];

const PHASE_1: Criterion[] = [
	{
		kind: "command",
		name: "P1.1 synthetic end-to-end and crash matrix",
		command: "bun test packages/control-plane/src/e2e",
	},
	{
		kind: "command",
		name: "P1.2 sqlite backup/restore conformance",
		command: "bun test packages/control-plane/src/storage",
	},
	{
		kind: "command",
		name: "P1.3 event replay and SSE cursor survive restart",
		command: "bun test packages/control-plane/src/events packages/server/src/events-sse.test.ts",
	},
	{
		kind: "command",
		name: "P1.4 all 13 legacy MCP tools pass golden parity",
		command: "bun test packages/mcp-server/src/golden/golden-parity.test.ts",
	},
	{
		kind: "command",
		name: "P1.5 SDK and HTTP produce equivalent results",
		command: "bun test packages/sdk/src/sdk.test.ts",
	},
	{
		kind: "command",
		name: "P1.6 both MCP transports serve the adapter",
		command: "bun test packages/mcp-server/src/application-adapter.test.ts",
	},
	{
		kind: "command",
		name: "P1.7 websocket boundary holds",
		command: "bun test packages/server/src/ws-authorization.test.ts",
	},
	{
		kind: "command",
		name: "P1.8 canary corpus absent from the 13 enumerated surfaces",
		command: "bun test packages/control-plane/src/redaction/canary-corpus.test.ts",
	},
	{
		kind: "command",
		name: "P1.9 environment conformance (Local, Docker, E2B — fails without E2B_API_KEY)",
		command: "bun test packages/control-plane/src/testing/env-conformance.test.ts",
	},
	{
		kind: "command",
		name: "P1.10 tmux metadata tags written and inventoried",
		command: "bun test packages/core",
	},
	{
		kind: "command",
		name: "P1.11 stale-worker fencing rejects the four fenced mutations",
		command: "bun test packages/control-plane/src/application",
	},
];

const PHASE_2: Criterion[] = [
	{
		kind: "command",
		name: "P2.1a claude driver lifecycle and recovery",
		command: "bun test packages/driver-claude packages/core packages/orchestrator",
	},
	{
		kind: "command",
		name: "P2.1b opencode driver lifecycle and recovery",
		command: "bun test packages/driver-opencode",
	},
	{
		kind: "command",
		name: "P2.2 containment suites (denied paths, sandbox policy, egress, plan-mode bash denial)",
		command: "bun test packages/driver-claude packages/driver-opencode",
	},
	{
		kind: "files",
		name: "P2.3 real candidate-workspace tracers recorded",
		files: [
			{
				path: "docs/evidence/autonomous-local/phase-2/claude-candidate-tracer.md",
				contains: ["command", "exit code", "sha", "timestamp"],
			},
			{
				path: "docs/evidence/autonomous-local/phase-2/opencode-candidate-tracer.md",
				contains: ["command", "exit code", "sha", "timestamp"],
			},
		],
	},
	{
		kind: "command",
		name: "P2.4 tracker and github credentials absent from both runtimes",
		command: "bun test packages/driver-claude packages/driver-opencode",
	},
	{
		kind: "command",
		name: "P2.5 human takeover and return",
		command:
			"bun test packages/control-plane/src/application/attachment.test.ts packages/driver-claude packages/driver-opencode",
	},
];

const PHASE_3: Criterion[] = [
	{
		kind: "command",
		name: "P3.1 failure→repair→review→repair tracer",
		command: "bun test packages/control-plane/src/e2e",
	},
	{
		kind: "command",
		name: "P3.2 evidence bound to candidate SHA (tasks 16 and 17 fail closed)",
		command:
			"bun test packages/control-plane/src/policy packages/control-plane/src/verification packages/control-plane/src/review",
	},
	{
		kind: "command",
		name: "P3.3 required review pauses on budget exhaustion",
		command: "bun test packages/control-plane/src/review",
	},
	{
		kind: "command",
		name: "P3.4 final-diff scanner rejects escapes and denied paths",
		command: "bun test packages/control-plane/src/verification",
	},
	{
		kind: "command",
		name: "P3.5 evidence-bundle publication blocks on redaction hit",
		command:
			"bun test packages/control-plane/src/secrets packages/control-plane/src/redaction packages/control-plane/src/evidence",
	},
	{
		kind: "command",
		name: "P3.6 canary corpus absent from all surfaces and diagnostic export",
		command:
			"bun test packages/control-plane/src/secrets packages/control-plane/src/redaction packages/control-plane/src/evidence",
	},
];

const PHASE_4A: Criterion[] = [
	{
		kind: "command",
		name: "P4A.1 exactly-one draft delivery survives the crash matrix",
		command: "bun test packages/forge-github/src/e2e.test.ts",
	},
	{
		kind: "command",
		name: "P4A.2 no merge-equivalent application operation exists",
		command: "bun test packages/forge-github packages/control-plane/src/ports",
	},
	{
		kind: "command",
		name: "P4A.3 branch tampering pauses rather than overwriting",
		command: "bun test packages/forge-github/src/e2e.test.ts",
	},
	{
		kind: "command",
		name: "P4A.4 no control-plane credential reaches a coding runtime",
		command: "bun test packages/driver-claude packages/driver-opencode",
	},
	{
		kind: "absent",
		name: "P4A.4b forge-github never referenced inside driver sources",
		dirs: ["packages/driver-claude/src", "packages/driver-opencode/src"],
		pattern: "forge-github",
	},
];

const PHASE_4B: Criterion[] = [
	{
		kind: "command",
		name: "P4B.1 linear intake correct without webhooks",
		command: "bun test packages/tracker-linear packages/control-plane/src/application",
	},
	{
		kind: "command",
		name: "P4B.2 duplicate and out-of-order deliveries produce exactly one task",
		command: "bun test packages/tracker-linear",
	},
	{
		kind: "files",
		name: "P4B.3 both drivers complete the live linear matrix",
		files: [
			{
				path: "docs/evidence/autonomous-local/phase-4b/gate.md",
				contains: ["claude-code", "opencode"],
			},
		],
	},
	{
		kind: "command",
		name: "P4B.4 approval binds exact hashes; all 9 invalidation causes asserted",
		command: "bun test packages/control-plane/src/application",
	},
];

const PHASE_4C: Criterion[] = [
	{
		kind: "command",
		name: "P4C.1 jira intake correct without webhooks; webhook renewal asserted",
		command: "bun test packages/tracker-jira",
	},
	{
		kind: "command",
		name: "P4C.2 transitions discovered, never hard-coded",
		command: "bun test packages/tracker-jira",
	},
	{
		kind: "files",
		name: "P4C.3 both drivers complete the live jira matrix",
		files: [
			{
				path: "docs/evidence/autonomous-local/phase-4c/gate.md",
				contains: ["claude-code", "opencode"],
			},
		],
	},
	{
		kind: "command",
		name: "P4C.4 jira remote agents behind experimental capability flag",
		command: "bun test packages/tracker-jira",
	},
];

const RELEASE: Criterion[] = [
	{ kind: "command", name: "R.2a lint", command: "bun run lint" },
	{ kind: "command", name: "R.2b typecheck", command: "bun run typecheck" },
	{ kind: "command", name: "R.2c unit suite", command: "bun test" },
	{ kind: "command", name: "R.2d build", command: "bun run build" },
	{
		kind: "command",
		name: "R.3/R.4 benchmark: each CLI ≥54/60 and every critical_scenario 3/3",
		command: "bun run benchmark:autonomous-local",
	},
	{ kind: "command", name: "R.2e fault suite", command: "bun run test:faults" },
	{
		kind: "command",
		name: "R.5 security suite: zero secret and zero prohibited-operation findings",
		command: "bun run test:security",
	},
	{
		kind: "command",
		name: "R.6 pilot ledger validates with zero lost tasks and zero prohibited operations",
		command: "bun test benchmarks/autonomous-local/pilot-ledger.test.ts",
	},
	{
		kind: "command",
		name: "R.7 sbom and provenance attestation",
		command: "bun scripts/generate-sbom.ts",
	},
	{
		kind: "files",
		name: "R.8 clean-machine lifecycle scripts exist",
		files: [
			{ path: "scripts/install-local.ts" },
			{ path: "scripts/doctor-local.ts" },
			{ path: "scripts/backup-local.ts" },
			{ path: "scripts/restore-local.ts" },
			{ path: "scripts/upgrade-local.ts" },
			{ path: "scripts/rollback-local.ts" },
			{ path: "scripts/rotate-credentials.ts" },
			{ path: "scripts/uninstall-local.ts" },
		],
	},
	{
		kind: "command",
		name: "R.8b install, doctor, backup, restore lifecycle",
		command:
			"bun scripts/install-local.ts --target /tmp/termbridge-clean && bun scripts/doctor-local.ts --home /tmp/termbridge-clean && bun scripts/backup-local.ts --home /tmp/termbridge-clean --out /tmp/tb-backup && bun scripts/restore-local.ts --home /tmp/termbridge-clean --from /tmp/tb-backup",
	},
	{
		kind: "command",
		name: "R.8c credential rotation and uninstall lifecycle",
		command:
			"bun scripts/rotate-credentials.ts --home /tmp/termbridge-clean && bun scripts/uninstall-local.ts --home /tmp/termbridge-clean",
	},
];

const PHASE_CRITERIA: Record<PhaseId, Criterion[]> = {
	"0": PHASE_0,
	"1": PHASE_1,
	"2": PHASE_2,
	"3": PHASE_3,
	"4a": PHASE_4A,
	"4b": PHASE_4B,
	"4c": PHASE_4C,
	release: RELEASE,
};

/** Phases whose gate.md must carry a filled reviewerSignOff field. */
const REQUIRE_REVIEWER_SIGNOFF: Partial<Record<PhaseId, boolean>> = { "1": true };

// --- gate runner ------------------------------------------------------------------

export interface GateResult {
	ok: boolean;
	results: CriterionResult[];
}

export async function runGateCheck(phase: PhaseId, ctx: GateContext): Promise<GateResult> {
	if (!PHASE_IDS.includes(phase)) {
		throw new Error(`unknown phase "${phase}" — expected one of ${PHASE_IDS.join(", ")}`);
	}
	const results: CriterionResult[] = [];

	// (a) Every task checkbox in the phase's plan section is checked.
	const plan = readFileSync(join(ctx.root, PLAN_PATH), "utf8");
	const unchecked = countUnchecked(extractPhaseSection(plan, phase));
	results.push({
		name: `phase ${phase} task checkboxes complete`,
		ok: unchecked === 0,
		detail: unchecked === 0 ? "no unchecked boxes" : `${unchecked} unchecked box(es) in the plan`,
	});

	// (b) The phase's gate.md exists and its json record validates.
	const evidence = readGateEvidence(ctx.root, phase);
	const evidenceErrors = [...evidence.errors];
	if (
		REQUIRE_REVIEWER_SIGNOFF[phase] &&
		evidence.record !== null &&
		(typeof evidence.record.reviewerSignOff !== "string" ||
			evidence.record.reviewerSignOff.length === 0)
	) {
		evidenceErrors.push("reviewerSignOff must be filled before live provider work begins");
	}
	results.push({
		name: `phase ${phase} gate evidence validates`,
		ok: evidenceErrors.length === 0,
		detail: evidenceErrors.length === 0 ? "gate.md json record valid" : evidenceErrors.join("; "),
	});

	// The release gate additionally requires every prior phase's evidence.
	if (phase === "release") {
		const prior: PhaseId[] = ["0", "1", "2", "3", "4a", "4b", "4c"];
		const problems: string[] = [];
		for (const priorPhase of prior) {
			const read = readGateEvidence(ctx.root, priorPhase);
			problems.push(...read.errors.map((error) => `phase ${priorPhase}: ${error}`));
		}
		results.push({
			name: "R.1 every prior phase gate evidence validates",
			ok: problems.length === 0,
			detail:
				problems.length === 0 ? "all 7 prior phase gate.md records valid" : problems.join("; "),
		});
	}

	// (c) Every command the phase gate names exits clean.
	for (const criterion of PHASE_CRITERIA[phase]) {
		results.push(await evaluateCriterion(criterion, ctx));
	}

	return { ok: results.every((result) => result.ok), results };
}

// --- CLI --------------------------------------------------------------------------

function defaultExec(command: string, cwd: string): Promise<ExecResult> {
	const proc = spawnSync("/bin/sh", ["-c", command], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}${proc.error ? String(proc.error) : ""}`;
	return Promise.resolve({ exitCode: proc.status ?? 1, output });
}

async function main(argv: string[]): Promise<number> {
	const phaseIndex = argv.indexOf("--phase");
	const phase = phaseIndex === -1 ? undefined : argv[phaseIndex + 1];
	if (!phase || !PHASE_IDS.includes(phase as PhaseId)) {
		console.error(`usage: bun scripts/gate-check.ts --phase <${PHASE_IDS.join("|")}>`);
		return 2;
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const result = await runGateCheck(phase as PhaseId, { root, exec: defaultExec });
	for (const entry of result.results) {
		console.log(`${entry.ok ? "✓" : "✗"} ${entry.name} — ${entry.detail}`);
	}
	console.log(`\nphase ${phase} gate: ${result.ok ? "PASS" : "FAIL"}`);
	return result.ok ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
