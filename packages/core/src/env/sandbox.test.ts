// Unit tests for SandboxEnvironment — runs tmux INSIDE a cloud sandbox via a
// pluggable `SandboxProvider`, behind the same `Environment` interface as
// LocalEnvironment / DockerEnvironment. Every test injects a recording MOCK
// provider that records each ensure/exec/destroy call and returns a configurable
// `ExecResult` per exec index — no real cloud, no real tmux.

import { describe, expect, it } from "bun:test";
import type { ExecResult } from "../types.js";
import { SandboxEnvironment, type SandboxProvider } from "./sandbox.js";

interface EnsureCall {
	name: string;
	cwd: string;
	image?: string;
	env?: Record<string, string>;
}

interface MockProvider extends SandboxProvider {
	ensureCalls: EnsureCall[];
	execCalls: string[][];
	destroyCalls: number;
}

/**
 * Build a recording mock `SandboxProvider`. `execResults` supplies a
 * configurable `ExecResult` per `exec` call index (default: code 0).
 */
function makeProvider(execResults: Array<Partial<ExecResult>> = []): MockProvider {
	const ensureCalls: EnsureCall[] = [];
	const execCalls: string[][] = [];
	let destroyCalls = 0;
	let i = 0;
	return {
		name: "mock",
		ensureCalls,
		execCalls,
		get destroyCalls() {
			return destroyCalls;
		},
		async ensure(opts) {
			ensureCalls.push(opts);
		},
		async exec(args) {
			execCalls.push(args);
			const r = execResults[i++] ?? {};
			return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
		},
		async destroy() {
			destroyCalls++;
		},
	};
}

const baseOpts = {
	name: "sess",
	cwd: "/work",
	cols: 80,
	rows: 24,
};

describe("SandboxEnvironment", () => {
	it("has kind 'sandbox'", () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		expect(env.kind).toBe("sandbox");
	});

	it("ensureSession calls provider.ensure then creates the tmux session", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession(baseOpts);

		// provider.ensure called once with name/cwd/env.
		expect(provider.ensureCalls).toEqual([{ name: "sess", cwd: "/work", env: undefined }]);

		// exactly one exec: the tmux new-session argv, pinned to -L socket.
		expect(provider.execCalls.length).toBe(1);
		expect(provider.execCalls[0]).toEqual([
			"tmux",
			"-L",
			"termbridge",
			"new-session",
			"-d",
			"-s",
			"sess",
			"-x",
			"80",
			"-y",
			"24",
			"-c",
			"/work",
		]);
	});

	it("ensureSession forwards env to provider.ensure and appends cmd to new-session", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession({ ...baseOpts, env: { FOO: "bar" }, cmd: "claude" });

		expect(provider.ensureCalls[0]).toEqual({
			name: "sess",
			cwd: "/work",
			env: { FOO: "bar" },
		});
		expect(provider.execCalls[0]).toEqual([
			"tmux",
			"-L",
			"termbridge",
			"new-session",
			"-d",
			"-s",
			"sess",
			"-x",
			"80",
			"-y",
			"24",
			"-c",
			"/work",
			"claude",
		]);
	});

	it("ensureSession honors a custom socket", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider, socket: "mysock" });
		await env.ensureSession(baseOpts);
		expect(provider.execCalls[0]?.slice(0, 3)).toEqual(["tmux", "-L", "mysock"]);
	});

	it("ensureSession throws when tmux new-session returns non-zero", async () => {
		const provider = makeProvider([{ code: 1, stderr: "no tmux" }]);
		const env = new SandboxEnvironment({ provider });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow("tmux new-session failed: no tmux");
		// ensure still ran (sandbox was provisioned); only the session creation failed.
		expect(provider.ensureCalls.length).toBe(1);
		expect(provider.execCalls.length).toBe(1);
	});

	it("tmux() wraps args in 'tmux -L socket ...' and returns the result verbatim", async () => {
		const provider = makeProvider([{ code: 0, stdout: "screen-contents" }]);
		const env = new SandboxEnvironment({ provider });

		const res = await env.tmux(["capture-pane", "-p", "-t", "sess"]);

		expect(provider.execCalls[0]).toEqual([
			"tmux",
			"-L",
			"termbridge",
			"capture-pane",
			"-p",
			"-t",
			"sess",
		]);
		expect(res).toEqual({ stdout: "screen-contents", stderr: "", code: 0 });
	});

	it("tmux() returns non-zero results verbatim without rejecting", async () => {
		const provider = makeProvider([{ code: 1, stderr: "nope" }]);
		const env = new SandboxEnvironment({ provider });
		const res = await env.tmux(["has-session", "-t", "sess"]);
		expect(res).toEqual({ stdout: "", stderr: "nope", code: 1 });
	});

	it("tmux() works before ensureSession (provider owns lifecycle)", async () => {
		const provider = makeProvider([{ code: 0, stdout: "ok" }]);
		const env = new SandboxEnvironment({ provider });
		const res = await env.tmux(["list-sessions"]);
		expect(res.stdout).toBe("ok");
		expect(provider.execCalls[0]).toEqual(["tmux", "-L", "termbridge", "list-sessions"]);
	});

	it("destroySession calls provider.destroy", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.destroySession("sess");
		expect(provider.destroyCalls).toBe(1);
	});

	it("destroySession never throws when provider.destroy rejects", async () => {
		const provider = makeProvider();
		provider.destroy = async () => {
			throw new Error("sandbox API down");
		};
		const env = new SandboxEnvironment({ provider });
		await expect(env.destroySession("sess")).resolves.toBeUndefined();
	});

	it("listSessions parses trimmed non-empty session names from stdout", async () => {
		const provider = makeProvider([{ code: 0, stdout: "alpha\n beta \n\ngamma\n" }]);
		const env = new SandboxEnvironment({ provider });

		const names = await env.listSessions();
		expect(names).toEqual(["alpha", "beta", "gamma"]);
		expect(provider.execCalls[0]).toEqual([
			"tmux",
			"-L",
			"termbridge",
			"list-sessions",
			"-F",
			"#{session_name}",
		]);
	});

	it("listSessions returns [] on non-zero exit", async () => {
		const provider = makeProvider([{ code: 1, stderr: "no server running" }]);
		const env = new SandboxEnvironment({ provider });
		expect(await env.listSessions()).toEqual([]);
	});

	it("attachPty throws (web/M5 only)", () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		expect(() => env.attachPty("sess", { cols: 80, rows: 24 })).toThrow("attachPty: web/M5 only");
	});
});

// ---------------------------------------------------------------------------
// ADVERSARIAL tests — trying to break the implementation.
// ---------------------------------------------------------------------------

describe("SandboxEnvironment (adversarial)", () => {
	it("ensureSession calls provider.ensure BEFORE the new-session exec (ordering)", async () => {
		const order: string[] = [];
		const provider = makeProvider();
		const origEnsure = provider.ensure;
		provider.ensure = async (opts) => {
			order.push("ensure");
			await origEnsure(opts);
		};
		const origExec = provider.exec.bind(provider);
		provider.exec = async (args) => {
			order.push("exec");
			return origExec(args);
		};
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession(baseOpts);
		expect(order).toEqual(["ensure", "exec"]);
	});

	it("does not call exec if provider.ensure rejects", async () => {
		const provider = makeProvider();
		provider.ensure = async () => {
			throw new Error("boot failed");
		};
		const env = new SandboxEnvironment({ provider });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow("boot failed");
		expect(provider.execCalls.length).toBe(0);
	});

	it("cmd with spaces is passed as a single trailing token (no splitting)", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession({ ...baseOpts, cmd: "claude --resume foo" });
		const args = provider.execCalls[0] ?? [];
		expect(args[args.length - 1]).toBe("claude --resume foo");
	});

	it("cols/rows are stringified exactly (zero, large)", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession({ ...baseOpts, cols: 0, rows: 9999 });
		const args = provider.execCalls[0] ?? [];
		const xIdx = args.indexOf("-x");
		const yIdx = args.indexOf("-y");
		expect(args[xIdx + 1]).toBe("0");
		expect(args[yIdx + 1]).toBe("9999");
	});

	it("cwd with spaces is passed verbatim as one -c token", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession({ ...baseOpts, cwd: "/my work/dir" });
		const args = provider.execCalls[0] ?? [];
		const cIdx = args.indexOf("-c");
		expect(args[cIdx + 1]).toBe("/my work/dir");
	});

	it("tmux() passes through an empty args array (just -L socket)", async () => {
		const provider = makeProvider([{ code: 0 }]);
		const env = new SandboxEnvironment({ provider });
		await env.tmux([]);
		expect(provider.execCalls[0]).toEqual(["tmux", "-L", "termbridge"]);
	});

	it("default socket can be overridden by TERMBRIDGE_TMUX_SOCKET env var", async () => {
		const prev = process.env.TERMBRIDGE_TMUX_SOCKET;
		process.env.TERMBRIDGE_TMUX_SOCKET = "envsock";
		try {
			const provider = makeProvider();
			const env = new SandboxEnvironment({ provider });
			await env.ensureSession(baseOpts);
			expect(provider.execCalls[0]?.slice(0, 3)).toEqual(["tmux", "-L", "envsock"]);
		} finally {
			if (prev === undefined) delete process.env.TERMBRIDGE_TMUX_SOCKET;
			else process.env.TERMBRIDGE_TMUX_SOCKET = prev;
		}
	});

	it("explicit socket option beats TERMBRIDGE_TMUX_SOCKET env var", async () => {
		const prev = process.env.TERMBRIDGE_TMUX_SOCKET;
		process.env.TERMBRIDGE_TMUX_SOCKET = "envsock";
		try {
			const provider = makeProvider();
			const env = new SandboxEnvironment({ provider, socket: "explicit" });
			await env.ensureSession(baseOpts);
			expect(provider.execCalls[0]?.[2]).toBe("explicit");
		} finally {
			if (prev === undefined) delete process.env.TERMBRIDGE_TMUX_SOCKET;
			else process.env.TERMBRIDGE_TMUX_SOCKET = prev;
		}
	});

	it("listSessions returns [] for whitespace-only stdout on success", async () => {
		const provider = makeProvider([{ code: 0, stdout: "  \n \t \n" }]);
		const env = new SandboxEnvironment({ provider });
		expect(await env.listSessions()).toEqual([]);
	});

	it("listSessions handles CRLF, leading/trailing whitespace, and tabs", async () => {
		const provider = makeProvider([
			{ code: 0, stdout: "  alpha  \r\n\tbeta\t\r\n\r\n   \r\ngamma\n" },
		]);
		const env = new SandboxEnvironment({ provider });
		expect(await env.listSessions()).toEqual(["alpha", "beta", "gamma"]);
	});

	it("destroySession swallows a synchronous-style rejection without surfacing it", async () => {
		const provider = makeProvider();
		let called = 0;
		provider.destroy = async () => {
			called++;
			throw new Error("rejected");
		};
		const env = new SandboxEnvironment({ provider });
		await expect(env.destroySession("x")).resolves.toBeUndefined();
		expect(called).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// VERIFIER adversarial additions — pushing harder on contract edges.
// ---------------------------------------------------------------------------

describe("SandboxEnvironment (verifier adversarial)", () => {
	it("ensureSession with non-zero exit surfaces stderr verbatim (even empty)", async () => {
		const provider = makeProvider([{ code: 2, stderr: "" }]);
		const env = new SandboxEnvironment({ provider });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow("tmux new-session failed: ");
	});

	it("ensureSession with non-zero exit and undefined stderr stringifies as 'undefined'", async () => {
		// stderr is non-optional in ExecResult; a misbehaving provider returning
		// undefined would concat to 'undefined' rather than crash. Confirm no throw
		// of a different shape (TypeError) leaks.
		const provider = makeProvider();
		provider.exec = async () => ({ stdout: "", code: 1 }) as unknown as ExecResult;
		const env = new SandboxEnvironment({ provider });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow("tmux new-session failed:");
	});

	it("ensureSession does NOT forward image to provider.ensure (not in EnsureSessionOptions)", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession(baseOpts);
		expect(provider.ensureCalls[0]).not.toHaveProperty("image");
	});

	it("empty-string cmd is falsy and produces NO trailing token", async () => {
		// opts.cmd ? [opts.cmd] : [] — empty string is falsy, so no token appended.
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.ensureSession({ ...baseOpts, cmd: "" });
		const args = provider.execCalls[0] ?? [];
		expect(args[args.length - 1]).toBe("/work");
		expect(args).not.toContain("");
	});

	it("empty-string socket option is preserved verbatim (not coalesced to default)", async () => {
		// `opts.socket ?? ...` only coalesces nullish; "" is kept. This documents a
		// potential footgun: an empty socket reaches tmux as `-L ''`.
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider, socket: "" });
		await env.ensureSession(baseOpts);
		expect(provider.execCalls[0]?.[1]).toBe("-L");
		expect(provider.execCalls[0]?.[2]).toBe("");
	});

	it("tmux() does not mutate the caller's args array", async () => {
		const provider = makeProvider([{ code: 0 }]);
		const env = new SandboxEnvironment({ provider });
		const userArgs = ["capture-pane", "-p"];
		await env.tmux(userArgs);
		expect(userArgs).toEqual(["capture-pane", "-p"]);
	});

	it("listSessions tolerates a single name with no trailing newline", async () => {
		const provider = makeProvider([{ code: 0, stdout: "solo" }]);
		const env = new SandboxEnvironment({ provider });
		expect(await env.listSessions()).toEqual(["solo"]);
	});

	it("listSessions returns [] on non-zero EVEN when stdout has names (stale buffer)", async () => {
		// Guard against a backend that writes partial stdout then exits non-zero:
		// the code must NOT parse stale stdout.
		const provider = makeProvider([{ code: 1, stdout: "ghost\nsession", stderr: "crashed" }]);
		const env = new SandboxEnvironment({ provider });
		expect(await env.listSessions()).toEqual([]);
	});

	it("destroySession ignores the name argument (provider owns the one sandbox)", async () => {
		const provider = makeProvider();
		const env = new SandboxEnvironment({ provider });
		await env.destroySession("any-name-at-all");
		expect(provider.destroyCalls).toBe(1);
	});

	it("destroySession swallows a synchronous (non-async) throw from destroy", async () => {
		// A provider whose destroy throws synchronously before returning a promise.
		const provider = makeProvider();
		provider.destroy = (() => {
			throw new Error("sync boom");
		}) as unknown as () => Promise<void>;
		const env = new SandboxEnvironment({ provider });
		await expect(env.destroySession("x")).resolves.toBeUndefined();
	});

	it("each instance has its own socket (no shared mutable state across instances)", async () => {
		const a = makeProvider();
		const b = makeProvider();
		const envA = new SandboxEnvironment({ provider: a, socket: "sockA" });
		const envB = new SandboxEnvironment({ provider: b, socket: "sockB" });
		await envA.tmux(["x"]);
		await envB.tmux(["y"]);
		expect(a.execCalls[0]?.[2]).toBe("sockA");
		expect(b.execCalls[0]?.[2]).toBe("sockB");
	});

	it("ensureSession exec result is consumed, not returned (Promise<void>)", async () => {
		const provider = makeProvider([{ code: 0, stdout: "noise" }]);
		const env = new SandboxEnvironment({ provider });
		const ret = await env.ensureSession(baseOpts);
		expect(ret).toBeUndefined();
	});

	it("conforms to the Environment interface (structural)", () => {
		const provider = makeProvider();
		const env: import("../types.js").Environment = new SandboxEnvironment({ provider });
		expect(env.kind).toBe("sandbox");
		expect(typeof env.ensureSession).toBe("function");
		expect(typeof env.tmux).toBe("function");
		expect(typeof env.destroySession).toBe("function");
		expect(typeof env.listSessions).toBe("function");
	});
});
