import { describe, expect, test } from "bun:test";
import type { ExecFn, ExecResult } from "../types.js";
import { DEFAULT_TMUX_SOCKET, withTmuxSocket } from "./helpers.js";

function spy(): {
	exec: ExecFn;
	calls: Array<{ file: string; args: string[]; opts?: unknown }>;
} {
	const calls: Array<{ file: string; args: string[]; opts?: unknown }> = [];
	const ok: ExecResult = { stdout: "", stderr: "", code: 0 };
	const exec = ((file: string, args: string[], opts?: unknown) => {
		calls.push({ file, args, opts });
		return Promise.resolve(ok);
	}) as unknown as ExecFn;
	return { exec, calls };
}

describe("withTmuxSocket (safety: dedicated tmux server)", () => {
	test("prepends -L <socket> to every tmux invocation", async () => {
		const { exec, calls } = spy();
		const wrapped = withTmuxSocket(exec, "termbridge");
		await wrapped("tmux", ["new-session", "-d", "-s", "s1"]);
		expect(calls[0]?.args).toEqual(["-L", "termbridge", "new-session", "-d", "-s", "s1"]);
	});

	test("defaults the socket name to 'termbridge'", async () => {
		const { exec, calls } = spy();
		await withTmuxSocket(exec)("tmux", ["kill-session", "-t", "s1"]);
		expect(calls[0]?.args.slice(0, 2)).toEqual(["-L", DEFAULT_TMUX_SOCKET]);
		// never an unscoped kill that could reach the user's default server
		expect(calls[0]?.args).toEqual(["-L", "termbridge", "kill-session", "-t", "s1"]);
	});

	test("uses a custom socket name when given", async () => {
		const { exec, calls } = spy();
		await withTmuxSocket(exec, "termbridge-test")("tmux", ["list-sessions"]);
		expect(calls[0]?.args).toEqual(["-L", "termbridge-test", "list-sessions"]);
	});

	test("passes non-tmux commands through untouched", async () => {
		const { exec, calls } = spy();
		await withTmuxSocket(exec, "termbridge")("docker", ["ps", "-a"]);
		expect(calls[0]).toMatchObject({ file: "docker", args: ["ps", "-a"] });
	});

	test("preserves the opts argument (env/cwd)", async () => {
		const { exec, calls } = spy();
		await withTmuxSocket(exec, "termbridge")("tmux", ["new-session"], { env: { HOME: "/x" } });
		expect(calls[0]?.opts).toEqual({ env: { HOME: "/x" } });
	});
});
