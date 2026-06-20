import { describe, expect, mock, test } from "bun:test";
import type { ExecFn, ExecResult } from "../types.js";
import { LocalEnvironment } from "./local.js";

function makeExec(result: Partial<ExecResult> = {}): {
	exec: ExecFn;
	calls: Array<{
		file: string;
		args: string[];
		opts?: { env?: Record<string, string>; cwd?: string };
	}>;
} {
	const calls: Array<{
		file: string;
		args: string[];
		opts?: { env?: Record<string, string>; cwd?: string };
	}> = [];
	const full: ExecResult = { stdout: "", stderr: "", code: 0, ...result };
	const exec = mock(
		(file: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string }) => {
			calls.push({ file, args, opts });
			return Promise.resolve(full);
		},
	) as unknown as ExecFn;
	return { exec, calls };
}

describe("LocalEnvironment", () => {
	test("kind is 'local'", () => {
		const { exec } = makeExec();
		expect(new LocalEnvironment({ exec }).kind).toBe("local");
	});

	test("ensureSession delegates to tmux new-session with the right argv", async () => {
		const { exec, calls } = makeExec();
		const env = new LocalEnvironment({ exec });
		await env.ensureSession({ name: "s1", cwd: "/work", cmd: "claude", cols: 500, rows: 40 });
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.file).toBe("tmux");
		expect(call.args).toEqual([
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
			"claude",
		]);
	});

	test("ensureSession forwards env when provided", async () => {
		const { exec, calls } = makeExec();
		const env = new LocalEnvironment({ exec });
		await env.ensureSession({ name: "s", cwd: "/w", cols: 80, rows: 24, env: { A: "1" } });
		expect(calls[0]?.opts).toEqual({ env: { A: "1" } });
	});

	test("tmux passes args through and returns the ExecResult verbatim", async () => {
		const { exec, calls } = makeExec({ stdout: "out", stderr: "err", code: 3 });
		const env = new LocalEnvironment({ exec });
		const res = await env.tmux(["capture-pane", "-p", "-t", "s"]);
		expect(calls[0]).toEqual({
			file: "tmux",
			args: ["capture-pane", "-p", "-t", "s"],
			opts: undefined,
		});
		expect(res).toEqual({ stdout: "out", stderr: "err", code: 3 });
	});

	test("destroySession kills the session", async () => {
		const { exec, calls } = makeExec();
		const env = new LocalEnvironment({ exec });
		await env.destroySession("s1");
		expect(calls[0]?.args).toEqual(["kill-session", "-t", "s1"]);
	});

	test("listSessions parses tmux output into names", async () => {
		const { exec, calls } = makeExec({ stdout: "a\nb\n" });
		const env = new LocalEnvironment({ exec });
		const names = await env.listSessions();
		expect(calls[0]?.args).toEqual(["list-sessions", "-F", "#{session_name}"]);
		expect(names).toEqual(["a", "b"]);
	});

	test("listSessions returns [] when no server is running (non-zero exit)", async () => {
		const { exec } = makeExec({ code: 1, stderr: "no server running" });
		const env = new LocalEnvironment({ exec });
		expect(await env.listSessions()).toEqual([]);
	});

	test("attachPty throws (implemented in M5)", () => {
		const { exec } = makeExec();
		const env = new LocalEnvironment({ exec });
		expect(() => env.attachPty("s", { cols: 80, rows: 24 })).toThrow("M5");
	});
});
