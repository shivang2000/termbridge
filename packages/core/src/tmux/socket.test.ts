import { describe, expect, test } from "bun:test";
import { LocalEnvironment } from "../env/local.js";
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

describe("LocalEnvironment routes EVERY verb through -L termbridge (no default-socket escape)", () => {
	// Drive every operation a Session triggers, with the exec wrapped exactly as the
	// real default does (withTmuxSocket(defaultExec)). Locks the invariant that no
	// LocalEnvironment verb can reach the user's default tmux server. (The default
	// constructor's own wrapping is proven end-to-end by the local-mode smoke, which
	// asserts the host's default `tmux ls` is untouched.)
	test("new-session / capture-pane / send-keys / pipe-pane / resize / kill-session / ls all carry -L termbridge", async () => {
		const { exec, calls } = spy();
		const env = new LocalEnvironment({ exec: withTmuxSocket(exec, "termbridge") });

		await env.ensureSession({ name: "s1", cwd: "/w", cols: 80, rows: 24 });
		await env.tmux(["capture-pane", "-p", "-t", "s1"]);
		await env.tmux(["send-keys", "-t", "s1", "echo hi", "Enter"]);
		await env.tmux(["pipe-pane", "-O", "-t", "s1", "cat >> /tmp/x"]);
		await env.tmux(["resize-window", "-t", "s1", "-x", "100", "-y", "30"]);
		await env.destroySession("s1");
		await env.listSessions();

		expect(calls.length).toBeGreaterThan(5);
		for (const c of calls) {
			// LocalEnvironment must only ever spawn tmux, and always on the -L socket.
			expect(c.file).toBe("tmux");
			expect(c.args.slice(0, 2)).toEqual(["-L", "termbridge"]);
		}
	});
});
