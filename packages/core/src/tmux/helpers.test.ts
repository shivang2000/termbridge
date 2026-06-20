import { describe, expect, test } from "bun:test";
import type { ExecFn, ExecResult } from "../types.js";
import { TmuxHelpers } from "./helpers.js";

type Call = { file: string; args: string[]; opts?: { env?: Record<string, string>; cwd?: string } };

function makeExec(result: Partial<ExecResult> = {}): { exec: ExecFn; calls: Call[] } {
	const calls: Call[] = [];
	const full: ExecResult = { stdout: "", stderr: "", code: 0, ...result };
	const exec: ExecFn = (file, args, opts) => {
		calls.push({ file, args, opts });
		return Promise.resolve(full);
	};
	return { exec, calls };
}

describe("TmuxHelpers.newSession", () => {
	test("emits the full new-session argv with default cols/rows", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).newSession({ name: "s1", cwd: "/work" });
		expect(calls[0]?.args).toEqual([
			"new-session",
			"-d",
			"-s",
			"s1",
			"-x",
			"500",
			"-y",
			"40",
			"-c",
			"/work",
		]);
	});

	test("appends the command last when given", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).newSession({
			name: "s",
			cwd: "/w",
			cmd: "claude",
			cols: 80,
			rows: 24,
		});
		expect(calls[0]?.args.at(-1)).toBe("claude");
	});

	test("passes env as -e KEY=VALUE flags, never via the client process env", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).newSession({
			name: "s",
			cwd: "/w",
			env: { HOME: "/creds", FOO: "bar" },
		});
		const args = calls[0]?.args ?? [];
		// flags sit after -c <cwd> and before any command
		expect(args).toContain("-e");
		expect(args).toContain("HOME=/creds");
		expect(args).toContain("FOO=bar");
		expect(calls[0]?.opts).toBeUndefined();
	});

	test("-e flags come before the command", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).newSession({
			name: "s",
			cwd: "/w",
			cmd: "claude",
			env: { HOME: "/h" },
		});
		const args = calls[0]?.args ?? [];
		expect(args.indexOf("HOME=/h")).toBeLessThan(args.indexOf("claude"));
	});
});

describe("TmuxHelpers send/capture/pipe", () => {
	test("sendKeys (named key, not literal)", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).sendKeys("s", "Enter");
		expect(calls[0]?.args).toEqual(["send-keys", "-t", "s", "Enter"]);
	});

	test("sendKeys literal adds -l", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).sendKeys("s", "echo hi", { literal: true });
		expect(calls[0]?.args).toEqual(["send-keys", "-t", "s", "-l", "echo hi"]);
	});

	test("sendControl", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).sendControl("s", "C-c");
		expect(calls[0]?.args).toEqual(["send-keys", "-t", "s", "C-c"]);
	});

	test("capturePane returns stdout; scrollback adds -S -<n>", async () => {
		const { exec, calls } = makeExec({ stdout: "screen text" });
		const h = new TmuxHelpers(exec);
		expect(await h.capturePane("s")).toBe("screen text");
		expect(calls[0]?.args).toEqual(["capture-pane", "-p", "-t", "s"]);
		await h.capturePane("s", { scrollback: 100 });
		expect(calls[1]?.args).toEqual(["capture-pane", "-p", "-t", "s", "-S", "-100"]);
	});

	test("pipePaneStart taps to a file with -O", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).pipePaneStart("s", "/tmp/p.log");
		expect(calls[0]?.args).toEqual(["pipe-pane", "-O", "-t", "s", "cat >> /tmp/p.log"]);
	});
});

describe("TmuxHelpers session lifecycle", () => {
	test("hasSession maps exit code (0 -> true, non-zero -> false)", async () => {
		expect(await new TmuxHelpers(makeExec({ code: 0 }).exec).hasSession("s")).toBe(true);
		expect(await new TmuxHelpers(makeExec({ code: 1 }).exec).hasSession("s")).toBe(false);
	});

	test("killSession", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).killSession("s");
		expect(calls[0]?.args).toEqual(["kill-session", "-t", "s"]);
	});

	test("listSessions parses names; [] on non-zero (no server)", async () => {
		const ok = makeExec({ stdout: "a\nb\n" });
		expect(await new TmuxHelpers(ok.exec).listSessions()).toEqual(["a", "b"]);
		expect(ok.calls[0]?.args).toEqual(["list-sessions", "-F", "#{session_name}"]);
		const none = makeExec({ code: 1, stderr: "no server running" });
		expect(await new TmuxHelpers(none.exec).listSessions()).toEqual([]);
	});

	test("resizeWindow stringifies dims", async () => {
		const { exec, calls } = makeExec();
		await new TmuxHelpers(exec).resizeWindow("s", 120, 40);
		expect(calls[0]?.args).toEqual(["resize-window", "-t", "s", "-x", "120", "-y", "40"]);
	});
});
