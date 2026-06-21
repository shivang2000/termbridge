// Engineer-loop smoke (Phase B) — the headless, end-to-end proof of the M7 loop.
// In a real Docker claude session (subscription auth), the loop delegates a tiny
// coding task: a failing `bun test` that claude must fix. The loop streams digests,
// auto-approves prompts, gates "done" on the test passing, and ends met:true.
// Run on the host (spawns a real container; uses subscription tokens):
//   bun scripts/smoke-engineer-loop.ts
// Prereqs: termbridge:dev image + docker up + creds at ~/.termbridge/home.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../packages/core/src/index.ts";
import { createToolSpecs } from "../packages/mcp-server/src/index.ts";
import { runEngineerLoop, type ToolCall } from "../packages/orchestrator/src/index.ts";

function assert(c: unknown, m: string): asserts c {
	if (!c) throw new Error(`ENGINEER-LOOP SMOKE FAILED: ${m}`);
}

const home = process.env.TERMBRIDGE_HOME ?? join(homedir(), ".termbridge", "home");
const pipeDir = mkdtempSync(join(process.cwd(), ".dogfood-loop-pipes-"));
// A throwaway repo with a FAILING test for claude to fix (bound into the container).
const repo = mkdtempSync(join(process.cwd(), ".dogfood-loop-repo-"));
writeFileSync(
	join(repo, "package.json"),
	JSON.stringify({ name: "loop-fixture", scripts: { test: "bun test" } }, null, 2),
);
writeFileSync(
	join(repo, "sum.ts"),
	"export function add(a: number, b: number): number {\n\treturn 0; // BUG: should return a + b\n}\n",
);
writeFileSync(
	join(repo, "sum.test.ts"),
	'import { expect, test } from "bun:test";\nimport { add } from "./sum";\ntest("add", () => {\n\texpect(add(2, 3)).toBe(5);\n});\n',
);

const mgr = new SessionManager({ maxSessions: 1, pipeDir, homeDir: home, allowedEnvs: ["docker"] });
const specs = createToolSpecs(mgr);
const byName = new Map(specs.map((s) => [s.name, s]));
const tools: ToolCall = (name, args) => {
	const spec = byName.get(name);
	if (!spec) throw new Error(`unknown tool: ${name}`);
	return spec.handler(args);
};

let sessionId: string | undefined;
try {
	console.log(`[loop] repo=${repo}  (failing bun test; claude must fix add())`);
	const res = await runEngineerLoop({
		tools,
		task: {
			goal: "The test in sum.test.ts is failing. Fix the add() function in sum.ts so the test passes.",
			acceptance: ["`bun test` passes (the add test is green)"],
			cwd: repo,
			env: "docker",
			cmd: "claude",
			verifyCmd: "bun test",
		},
		cadenceMs: 15000,
		maxRounds: 4,
		onDigest: (d) => console.log(`[loop] r${d.round} ${d.idle ? "(idle) " : ""}${d.summary}`),
		log: (m) => console.log(`[loop] · ${m}`),
	});
	sessionId = res.sessionId;

	console.log(`[loop] result: ${JSON.stringify({ met: res.met, rounds: res.rounds })}`);
	assert(res.met, `loop reported acceptance met (got: ${res.finalSummary})`);

	// Independent host-side check: the edit landed and the test really passes now.
	// (bun test reports to stderr + exit code; rely on the exit code — 0 = green.)
	let hostGreen = true;
	try {
		execFileSync("bun", ["test"], { cwd: repo, stdio: "ignore" });
	} catch {
		hostGreen = false;
	}
	assert(hostGreen, "host `bun test` is green (claude's fix landed on the bound repo)");
	console.log("[loop] ✓ host bun test is green — claude's fix landed on the bound repo");

	console.log("\n[loop] ENGINEER-LOOP SMOKE PASSED ✅");
} catch (err) {
	console.error(
		`\n[loop] ENGINEER-LOOP SMOKE FAILED ❌\n${err instanceof Error ? err.stack : String(err)}`,
	);
	process.exitCode = 1;
} finally {
	if (sessionId) await mgr.close(sessionId).catch(() => {});
	try {
		execFileSync("docker", ["ps", "-aq", "--filter", "name=termbridge-"])
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.forEach((c) => execFileSync("docker", ["rm", "-f", c], { stdio: "ignore" }));
	} catch {}
	rmSync(pipeDir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
}
