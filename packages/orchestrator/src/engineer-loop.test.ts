import { describe, expect, test } from "bun:test";
import {
	assess,
	buildEngineerPrompt,
	correctivePrompt,
	DONE_SENTINEL,
	type EngineerTask,
	runEngineerLoop,
	summarizeProgress,
	type ToolCall,
} from "./engineer-loop.js";

interface Script {
	idle?: Array<{ idle: boolean }>;
	progress?: Array<Record<string, unknown>>;
	screens?: string[];
}

/** A scriptable ToolCall + a record of every call, for driving the loop deterministically. */
function mockTools(script: Script): {
	tools: ToolCall;
	calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	let ii = 0;
	let pi = 0;
	let si = 0;
	let offset = 0;
	const last = <T>(a: T[] | undefined): T | undefined =>
		a && a.length ? a[a.length - 1] : undefined;
	const tools: ToolCall = async (name, args) => {
		calls.push({ name, args });
		switch (name) {
			case "open_session":
				return { id: "s1", name: "tb-s1", env: args.env };
			case "wait_for_idle":
				return script.idle?.[ii++] ?? { idle: true };
			case "read_progress": {
				const v = script.progress?.[pi++] ?? {
					phase: null,
					delta: "",
					nextOffset: offset,
					idle: true,
				};
				offset = (v.nextOffset as number) ?? offset;
				return v;
			}
			case "read_screen":
				return { screen: script.screens?.[si++] ?? last(script.screens) ?? "" };
			default:
				return { ok: true };
		}
	};
	return { tools, calls };
}

const baseTask: EngineerTask = {
	goal: "implement add()",
	acceptance: ["bun test passes"],
	cwd: "/work",
	env: "docker",
	verifyCmd: "bun test",
};

function sent(calls: Array<{ name: string; args: Record<string, unknown> }>, name: string) {
	return calls.filter((c) => c.name === name);
}

describe("runEngineerLoop control flow", () => {
	test("happy path: turn 1 idle + PASS sentinel → met in 1 round, no corrective", async () => {
		const { tools, calls } = mockTools({
			idle: [{ idle: true }],
			progress: [{ phase: "idle", delta: "all done\n", nextOffset: 10, awaitingInput: false }],
			screens: [`work…\n${DONE_SENTINEL} PASS\n`],
		});
		const res = await runEngineerLoop({ tools, task: baseTask });
		expect(res.met).toBe(true);
		expect(res.rounds).toBe(1);
		expect(res.sessionId).toBe("s1");
		// the engineering prompt was the first send_text; no corrective nudge followed.
		const texts = sent(calls, "send_text");
		expect(texts).toHaveLength(1);
		expect(String(texts[0]?.args.text)).toContain("implement add()");
	});

	test("auto-approves a blocking permission prompt, then completes", async () => {
		const { tools, calls } = mockTools({
			// [0] = boot wait_for_idle / boot approveIfBlocked (not blocked), then the pump.
			idle: [{ idle: true }, { idle: false }, { idle: true }],
			progress: [
				{ phase: "thinking", awaitingInput: false, nextOffset: 1 },
				{ phase: "awaiting_input", awaitingInput: true, delta: "approve?\n", nextOffset: 5 },
				{ phase: "idle", delta: "", nextOffset: 8 },
			],
			screens: [`${DONE_SENTINEL} PASS`],
		});
		const res = await runEngineerLoop({ tools, task: baseTask });
		expect(res.met).toBe(true);
		const ctrl = sent(calls, "send_control");
		expect(ctrl.length).toBeGreaterThanOrEqual(1);
		expect(ctrl.some((c) => c.args.key === "Enter")).toBe(true);
	});

	test("corrective nudge then done: 2 rounds, exactly one corrective", async () => {
		const { tools, calls } = mockTools({
			idle: [{ idle: true }, { idle: true }],
			progress: [
				{ phase: "idle", delta: "thinking…\n", nextOffset: 4 },
				{ phase: "idle", delta: "fixed it\n", nextOffset: 9 },
			],
			screens: ["no sentinel yet", `${DONE_SENTINEL} PASS`],
		});
		const res = await runEngineerLoop({ tools, task: baseTask });
		expect(res.met).toBe(true);
		expect(res.rounds).toBe(2);
		// send_text #1 = engineering prompt, #2 = corrective.
		const texts = sent(calls, "send_text");
		expect(texts).toHaveLength(2);
		expect(String(texts[1]?.args.text)).toContain("have not yet printed");
	});

	test("budget exhaustion: never done → met:false, rounds = maxRounds", async () => {
		const { tools } = mockTools({
			idle: [{ idle: true }, { idle: true }],
			progress: [
				{ phase: "idle", nextOffset: 1 },
				{ phase: "idle", nextOffset: 2 },
			],
			screens: ["still working, no sentinel"],
		});
		const res = await runEngineerLoop({ tools, task: baseTask, maxRounds: 2 });
		expect(res.met).toBe(false);
		expect(res.rounds).toBe(2);
		expect(res.finalSummary).toContain("not met");
	});

	test("elicitAcceptance is called when acceptance is empty and folded into the prompt", async () => {
		const { tools, calls } = mockTools({
			idle: [{ idle: true }],
			progress: [{ phase: "idle", nextOffset: 3 }],
			screens: [`${DONE_SENTINEL} PASS`],
		});
		let elicited = 0;
		const task: EngineerTask = { goal: "do X", cwd: "/work", env: "docker" };
		const res = await runEngineerLoop({
			tools,
			task,
			elicitAcceptance: async () => {
				elicited++;
				return ["the widget renders"];
			},
		});
		expect(elicited).toBe(1);
		expect(res.acceptance).toEqual(["the widget renders"]);
		const prompt = String(sent(calls, "send_text")[0]?.args.text);
		expect(prompt).toContain("the widget renders");
	});

	test("emits a digest per pump tick", async () => {
		const seen: string[] = [];
		const { tools } = mockTools({
			// [0] = boot wait_for_idle / boot approveIfBlocked (not blocked), then 2 pump ticks.
			idle: [{ idle: true }, { idle: false }, { idle: true }],
			progress: [
				{ phase: "idle", awaitingInput: false, nextOffset: 1 },
				{ phase: "tool", delta: "● Bash(bun test)\n", nextOffset: 5 },
				{ phase: "idle", delta: "", nextOffset: 6 },
			],
			screens: [`${DONE_SENTINEL} PASS`],
		});
		await runEngineerLoop({ tools, task: baseTask, onDigest: (d) => seen.push(d.summary) });
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(seen.some((s) => s.includes("Bash"))).toBe(true);
	});

	test("a turn that never goes idle is bounded by the per-turn tick ceiling (no hang)", async () => {
		const seen: string[] = [];
		const { tools } = mockTools({
			// boot + always-not-idle ticks; the pump must stop at maxTurnTicks.
			idle: [{ idle: false }, { idle: false }, { idle: false }, { idle: false }, { idle: false }],
			progress: [
				{ phase: "tool", nextOffset: 1 },
				{ phase: "tool", nextOffset: 2 },
				{ phase: "tool", nextOffset: 3 },
				{ phase: "tool", nextOffset: 4 },
				{ phase: "tool", nextOffset: 5 },
			],
			screens: ["no sentinel ever"],
		});
		// cadenceMs 10, turnTimeoutMs 30 => maxTurnTicks = 3.
		const res = await runEngineerLoop({
			tools,
			task: baseTask,
			maxRounds: 1,
			cadenceMs: 10,
			turnTimeoutMs: 30,
			onDigest: (d) => seen.push(d.summary),
		});
		expect(res.met).toBe(false);
		expect(res.rounds).toBe(1);
		expect(seen).toHaveLength(3); // exactly maxTurnTicks digests, then the turn bails
	});
});

describe("engineer-loop pure helpers", () => {
	test("buildEngineerPrompt carries goal, criteria, verify command, and sentinel", () => {
		const p = buildEngineerPrompt(baseTask, ["a", "b"]);
		expect(p).toContain("implement add()");
		expect(p).toContain("- a");
		expect(p).toContain("- b");
		expect(p).toContain("bun test");
		expect(p).toContain(`${DONE_SENTINEL} PASS`);
	});

	test("assess detects PASS, FAIL (+reason), and none", () => {
		expect(assess(`x\n${DONE_SENTINEL} PASS\n`)).toEqual({ done: true, pass: true });
		expect(assess(`${DONE_SENTINEL} FAIL cannot resolve dep`)).toEqual({
			done: true,
			pass: false,
			reason: "cannot resolve dep",
		});
		expect(assess("just working")).toEqual({ done: false, pass: false });
	});

	test("assess ignores the echoed prompt instruction but accepts claude's standalone/bulleted line", () => {
		// The prompt's own instruction line (marker mid-sentence) must NOT count as done.
		const echo = "- When (and ONLY when) it passes print a line: TB_LOOP_DONE: PASS";
		expect(assess(echo)).toEqual({ done: false, pass: false });
		// Claude's real print — indented or with a TUI bullet prefix — DOES count.
		expect(assess("  TB_LOOP_DONE: PASS").done).toBe(true);
		expect(assess("⏺ TB_LOOP_DONE: PASS").done).toBe(true);
	});

	test("correctivePrompt differs for a FAIL vs a missing sentinel", () => {
		expect(correctivePrompt(["a"], { done: true, pass: false, reason: "blocked" })).toContain(
			"printed a FAIL",
		);
		expect(correctivePrompt(["a"], { done: false, pass: false })).toContain("have not yet printed");
	});

	test("summarizeProgress formats tool/file + the last delta line", () => {
		const s = summarizeProgress({
			phase: "tool",
			delta: "noise\n● Update(pkg.json)\n",
			events: [{ kind: "claude-activity", data: { tool: "Update", file: "pkg.json" } }],
		});
		expect(s).toContain("Update(pkg.json)");
	});
});
