// Unit tests for DockerEnvironment — runs tmux INSIDE a per-session Docker
// container via the `docker` CLI, behind the same `Environment` interface as
// LocalEnvironment. Every test injects a mock `ExecFn` that records each
// {file,args} call and asserts the EXACT docker argv — no real docker/tmux.

import { describe, expect, it } from "bun:test";
import type { ExecFn, ExecResult } from "../types.js";
import { DockerEnvironment } from "./docker.js";

interface Call {
	file: string;
	args: string[];
}

/**
 * Build a mock `ExecFn` that records every call and returns a configurable
 * `ExecResult` per call index. By default each call resolves with code 0.
 */
function makeExec(results: Array<Partial<ExecResult>> = []): { exec: ExecFn; calls: Call[] } {
	const calls: Call[] = [];
	let i = 0;
	const exec: ExecFn = async (file, args) => {
		calls.push({ file, args });
		const r = results[i++] ?? {};
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
	};
	return { exec, calls };
}

const baseOpts = {
	name: "sess",
	cwd: "/work",
	cols: 80,
	rows: 24,
};

describe("DockerEnvironment", () => {
	it("has kind 'docker'", () => {
		const { exec } = makeExec();
		const env = new DockerEnvironment({ exec });
		expect(env.kind).toBe("docker");
	});

	it("ensureSession runs the container then creates the tmux session (with mounts)", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);

		expect(calls.length).toBe(2);

		// 1) docker run -d --name <container> -v cwd:cwd -w cwd <image> tail -f /dev/null
		expect(calls[0]).toEqual({
			file: "docker",
			args: [
				"run",
				"-d",
				"--name",
				"termbridge-sess",
				"-v",
				"/work:/work",
				"-w",
				"/work",
				"termbridge:dev",
				"tail",
				"-f",
				"/dev/null",
			],
		});

		// 2) docker exec <container> tmux -L <socket> new-session ...
		expect(calls[1]).toEqual({
			file: "docker",
			args: [
				"exec",
				"termbridge-sess",
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
			],
		});
	});

	it("ensureSession passes env as -e flags and cmd as the trailing arg", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({
			...baseOpts,
			env: { FOO: "bar", BAZ: "qux" },
			cmd: "claude",
		});

		expect(calls[0]).toEqual({
			file: "docker",
			args: [
				"run",
				"-d",
				"--name",
				"termbridge-sess",
				"-v",
				"/work:/work",
				"-w",
				"/work",
				"-e",
				"FOO=bar",
				"-e",
				"BAZ=qux",
				"termbridge:dev",
				"tail",
				"-f",
				"/dev/null",
			],
		});

		expect(calls[1]).toEqual({
			file: "docker",
			args: [
				"exec",
				"termbridge-sess",
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
			],
		});
	});

	it("ensureSession adds a pipeDir bind-mount when pipeDir is set", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec, pipeDir: "/pipes" });
		await env.ensureSession(baseOpts);

		expect(calls[0]).toEqual({
			file: "docker",
			args: [
				"run",
				"-d",
				"--name",
				"termbridge-sess",
				"-v",
				"/work:/work",
				"-v",
				"/pipes:/pipes",
				"-w",
				"/work",
				"termbridge:dev",
				"tail",
				"-f",
				"/dev/null",
			],
		});
	});

	it("ensureSession omits the pipeDir mount when pipeDir is absent", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);

		expect(calls[0]?.args).not.toContain("/pipes:/pipes");
	});

	it("honors custom image, socket, and containerPrefix", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({
			exec,
			image: "myimg:1",
			socket: "mysock",
			containerPrefix: "tb_",
		});
		await env.ensureSession(baseOpts);

		expect(calls[0]).toEqual({
			file: "docker",
			args: [
				"run",
				"-d",
				"--name",
				"tb_sess",
				"-v",
				"/work:/work",
				"-w",
				"/work",
				"myimg:1",
				"tail",
				"-f",
				"/dev/null",
			],
		});
		expect(calls[1]?.args.slice(0, 5)).toEqual(["exec", "tb_sess", "tmux", "-L", "mysock"]);
	});

	it("throws when docker run fails (non-zero) and does not create a session", async () => {
		const { exec, calls } = makeExec([{ code: 1, stderr: "boom" }]);
		const env = new DockerEnvironment({ exec });

		await expect(env.ensureSession(baseOpts)).rejects.toThrow("docker run failed: boom");
		// Only the run was attempted — no tmux new-session.
		expect(calls.length).toBe(1);
	});

	it("cleans up (rm -f) then throws when tmux new-session fails", async () => {
		// call 0: run ok; call 1: new-session fails; call 2: rm -f cleanup.
		const { exec, calls } = makeExec([{ code: 0 }, { code: 1, stderr: "no tmux" }, { code: 0 }]);
		const env = new DockerEnvironment({ exec });

		await expect(env.ensureSession(baseOpts)).rejects.toThrow("tmux new-session failed: no tmux");

		expect(calls.length).toBe(3);
		expect(calls[2]).toEqual({
			file: "docker",
			args: ["rm", "-f", "termbridge-sess"],
		});
	});

	it("tmux() wraps args in docker exec with -L socket and returns the result verbatim", async () => {
		const { exec, calls } = makeExec([
			{ code: 0 }, // run
			{ code: 0 }, // new-session
			{ code: 0, stdout: "screen-contents" }, // tmux call
		]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);

		const res = await env.tmux(["capture-pane", "-p", "-t", "sess"]);

		expect(calls[2]).toEqual({
			file: "docker",
			args: [
				"exec",
				"termbridge-sess",
				"tmux",
				"-L",
				"termbridge",
				"capture-pane",
				"-p",
				"-t",
				"sess",
			],
		});
		expect(res).toEqual({ stdout: "screen-contents", stderr: "", code: 0 });
	});

	it("tmux() returns non-zero results verbatim without rejecting", async () => {
		const { exec } = makeExec([{ code: 0 }, { code: 0 }, { code: 1, stderr: "nope" }]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);

		const res = await env.tmux(["has-session", "-t", "sess"]);
		expect(res).toEqual({ stdout: "", stderr: "nope", code: 1 });
	});

	it("tmux() before ensureSession throws a clear error", async () => {
		const { exec } = makeExec();
		const env = new DockerEnvironment({ exec });
		await expect(env.tmux(["list-sessions"])).rejects.toThrow();
	});

	it("destroySession issues docker rm -f and ignores non-zero exit", async () => {
		const { exec, calls } = makeExec([{ code: 1, stderr: "No such container" }]);
		const env = new DockerEnvironment({ exec });

		await env.destroySession("gone");

		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual({
			file: "docker",
			args: ["rm", "-f", "termbridge-gone"],
		});
	});

	it("destroySession never throws even when exec rejects", async () => {
		const exec: ExecFn = async () => {
			throw new Error("docker daemon down");
		};
		const env = new DockerEnvironment({ exec });
		await expect(env.destroySession("x")).resolves.toBeUndefined();
	});

	it("listSessions parses trimmed non-empty session names from stdout", async () => {
		const { exec, calls } = makeExec([
			{ code: 0 }, // run
			{ code: 0 }, // new-session
			{ code: 0, stdout: "alpha\n beta \n\ngamma\n" }, // list-sessions
		]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);

		const names = await env.listSessions();
		expect(names).toEqual(["alpha", "beta", "gamma"]);

		expect(calls[2]).toEqual({
			file: "docker",
			args: [
				"exec",
				"termbridge-sess",
				"tmux",
				"-L",
				"termbridge",
				"list-sessions",
				"-F",
				"#{session_name}",
			],
		});
	});

	it("listSessions returns [] on non-zero exit", async () => {
		const { exec } = makeExec([{ code: 0 }, { code: 0 }, { code: 1, stderr: "no server running" }]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);

		expect(await env.listSessions()).toEqual([]);
	});

	it("attachPty throws (implemented in M5)", () => {
		const { exec } = makeExec();
		const env = new DockerEnvironment({ exec });
		expect(() => env.attachPty("sess", { cols: 80, rows: 24 })).toThrow(
			"attachPty is implemented in M5",
		);
	});
});

// ---------------------------------------------------------------------------
// ADVERSARIAL tests — trying to break the implementation.
// ---------------------------------------------------------------------------

describe("DockerEnvironment (adversarial)", () => {
	it("listSessions throws before ensureSession (no container)", async () => {
		const { exec } = makeExec();
		const env = new DockerEnvironment({ exec });
		await expect(env.listSessions()).rejects.toThrow();
	});

	it("env values containing spaces, quotes, and '=' are passed as one -e arg each (no shell splitting)", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({
			...baseOpts,
			env: {
				WITH_SPACE: "hello world",
				WITH_QUOTE: "a\"b'c",
				WITH_EQUALS: "k=v=z",
				EMPTY: "",
			},
		});
		// Each value must travel as a single argv token (execFile, not a shell).
		const args = calls[0]?.args ?? [];
		expect(args).toContain("WITH_SPACE=hello world");
		expect(args).toContain("WITH_QUOTE=a\"b'c");
		expect(args).toContain("WITH_EQUALS=k=v=z");
		expect(args).toContain("EMPTY=");
		// Insertion order preserved between image marker and tail.
		const imageIdx = args.indexOf("termbridge:dev");
		const firstEnvIdx = args.indexOf("-e");
		expect(firstEnvIdx).toBeGreaterThan(-1);
		expect(firstEnvIdx).toBeLessThan(imageIdx);
	});

	it("cwd with spaces produces a single -v 'path:path' token and -w token", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({ ...baseOpts, cwd: "/my work/dir" });
		const args = calls[0]?.args ?? [];
		expect(args).toContain("/my work/dir:/my work/dir");
		// -w followed by the raw cwd as one token.
		const wIdx = args.indexOf("-w");
		expect(args[wIdx + 1]).toBe("/my work/dir");
		// new-session -c uses the same cwd verbatim.
		expect(calls[1]?.args).toContain("/my work/dir");
	});

	it("pipeDir with spaces produces a single mount token", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec, pipeDir: "/pipe dir" });
		await env.ensureSession(baseOpts);
		expect(calls[0]?.args).toContain("/pipe dir:/pipe dir");
	});

	it("empty env object adds no -e flags", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({ ...baseOpts, env: {} });
		expect(calls[0]?.args).not.toContain("-e");
	});

	it("container name derives strictly from prefix + name (no collision with cwd/socket)", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec, containerPrefix: "p-" });
		await env.ensureSession({ ...baseOpts, name: "weird/name" });
		// --name uses prefix+name verbatim.
		const nameIdx = calls[0]?.args.indexOf("--name") ?? -1;
		expect(calls[0]?.args[nameIdx + 1]).toBe("p-weird/name");
		// exec target container matches.
		expect(calls[1]?.args[1]).toBe("p-weird/name");
	});

	it("after a failed ensureSession (run fail), tmux() still throws (container never set)", async () => {
		const { exec } = makeExec([{ code: 1, stderr: "x" }]);
		const env = new DockerEnvironment({ exec });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow();
		await expect(env.tmux(["list-sessions"])).rejects.toThrow(
			"DockerEnvironment.tmux called before ensureSession",
		);
	});

	it("after a failed ensureSession (new-session fail), container is NOT set so tmux() throws", async () => {
		const { exec } = makeExec([{ code: 0 }, { code: 1, stderr: "boom" }, { code: 0 }]);
		const env = new DockerEnvironment({ exec });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow();
		// Critical: container must remain unset since session failed.
		await expect(env.tmux(["list-sessions"])).rejects.toThrow(
			"DockerEnvironment.tmux called before ensureSession",
		);
		await expect(env.listSessions()).rejects.toThrow();
	});

	it("cleanup rm -f failure during new-session failure does NOT mask the original error", async () => {
		// run ok, new-session fails, rm -f ALSO fails (non-zero) — still throw the tmux error.
		const { exec, calls } = makeExec([
			{ code: 0 },
			{ code: 1, stderr: "tmux broke" },
			{ code: 125, stderr: "rm failed" },
		]);
		const env = new DockerEnvironment({ exec });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow(
			"tmux new-session failed: tmux broke",
		);
		expect(calls.length).toBe(3);
	});

	it("cleanup rm -f that REJECTS during new-session failure must NOT mask the root-cause error", async () => {
		// If the cleanup exec rejects (docker daemon dropped mid-teardown), the
		// caller must still see WHY ensureSession failed — not the cleanup error.
		let i = 0;
		const exec: ExecFn = async () => {
			i++;
			if (i === 1) return { stdout: "", stderr: "", code: 0 }; // run
			if (i === 2) return { stdout: "", stderr: "tmuxfail", code: 1 }; // new-session
			throw new Error("rm rejected"); // cleanup rm -f rejects
		};
		const env = new DockerEnvironment({ exec });
		await expect(env.ensureSession(baseOpts)).rejects.toThrow("tmux new-session failed: tmuxfail");
	});

	it("destroySession derives container from prefix+name even with custom prefix", async () => {
		const { exec, calls } = makeExec([{ code: 0 }]);
		const env = new DockerEnvironment({ exec, containerPrefix: "custom_" });
		await env.destroySession("abc");
		expect(calls[0]).toEqual({ file: "docker", args: ["rm", "-f", "custom_abc"] });
	});

	it("destroySession can target a DIFFERENT session than the one ensured (registry-style)", async () => {
		const { exec, calls } = makeExec([{ code: 0 }, { code: 0 }, { code: 0 }]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts); // container = termbridge-sess
		await env.destroySession("other");
		expect(calls[2]).toEqual({ file: "docker", args: ["rm", "-f", "termbridge-other"] });
	});

	it("listSessions handles CRLF, leading/trailing whitespace, and tabs", async () => {
		const { exec } = makeExec([
			{ code: 0 },
			{ code: 0 },
			{ code: 0, stdout: "  alpha  \r\n\tbeta\t\r\n\r\n   \r\ngamma\n" },
		]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);
		const names = await env.listSessions();
		// trim() removes \r and surrounding whitespace/tabs; blank lines dropped.
		expect(names).toEqual(["alpha", "beta", "gamma"]);
	});

	it("listSessions returns [] for empty stdout on success", async () => {
		const { exec } = makeExec([{ code: 0 }, { code: 0 }, { code: 0, stdout: "" }]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);
		expect(await env.listSessions()).toEqual([]);
	});

	it("listSessions returns [] for whitespace-only stdout on success", async () => {
		const { exec } = makeExec([{ code: 0 }, { code: 0 }, { code: 0, stdout: "  \n \t \n" }]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);
		expect(await env.listSessions()).toEqual([]);
	});

	it("cmd with spaces is passed as a single trailing token (no splitting)", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({ ...baseOpts, cmd: "claude --resume foo" });
		const args = calls[1]?.args ?? [];
		expect(args[args.length - 1]).toBe("claude --resume foo");
	});

	it("cols/rows are stringified exactly (zero, large)", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({ ...baseOpts, cols: 0, rows: 9999 });
		const args = calls[1]?.args ?? [];
		const xIdx = args.indexOf("-x");
		const yIdx = args.indexOf("-y");
		expect(args[xIdx + 1]).toBe("0");
		expect(args[yIdx + 1]).toBe("9999");
	});

	it("exact argv ordering: run flags appear before image, image before tail", async () => {
		const { exec, calls } = makeExec();
		const env = new DockerEnvironment({ exec, pipeDir: "/p" });
		await env.ensureSession({ ...baseOpts, env: { A: "1" } });
		const args = calls[0]?.args ?? [];
		const idx = (s: string) => args.indexOf(s);
		expect(idx("run")).toBe(0);
		expect(idx("-d")).toBe(1);
		expect(idx("--name")).toBeLessThan(idx("termbridge:dev"));
		expect(idx("-w")).toBeLessThan(idx("termbridge:dev"));
		expect(idx("-e")).toBeLessThan(idx("termbridge:dev"));
		// pipeDir mount comes after cwd mount, before -w.
		expect(args.indexOf("/work:/work")).toBeLessThan(args.indexOf("/p:/p"));
		expect(args.indexOf("/p:/p")).toBeLessThan(idx("-w"));
		// tail -f /dev/null is the tail.
		expect(args.slice(-3)).toEqual(["tail", "-f", "/dev/null"]);
	});

	it("tmux() passes through an empty args array (just -L socket)", async () => {
		const { exec, calls } = makeExec([{ code: 0 }, { code: 0 }, { code: 0 }]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession(baseOpts);
		await env.tmux([]);
		expect(calls[2]).toEqual({
			file: "docker",
			args: ["exec", "termbridge-sess", "tmux", "-L", "termbridge"],
		});
	});

	it("default socket can be overridden by TERMBRIDGE_TMUX_SOCKET env var", async () => {
		const prev = process.env.TERMBRIDGE_TMUX_SOCKET;
		process.env.TERMBRIDGE_TMUX_SOCKET = "envsock";
		try {
			const { exec, calls } = makeExec();
			const env = new DockerEnvironment({ exec });
			await env.ensureSession(baseOpts);
			expect(calls[1]?.args.slice(0, 5)).toEqual([
				"exec",
				"termbridge-sess",
				"tmux",
				"-L",
				"envsock",
			]);
		} finally {
			if (prev === undefined) delete process.env.TERMBRIDGE_TMUX_SOCKET;
			else process.env.TERMBRIDGE_TMUX_SOCKET = prev;
		}
	});

	it("explicit socket option beats TERMBRIDGE_TMUX_SOCKET env var", async () => {
		const prev = process.env.TERMBRIDGE_TMUX_SOCKET;
		process.env.TERMBRIDGE_TMUX_SOCKET = "envsock";
		try {
			const { exec, calls } = makeExec();
			const env = new DockerEnvironment({ exec, socket: "explicit" });
			await env.ensureSession(baseOpts);
			expect(calls[1]?.args[4]).toBe("explicit");
		} finally {
			if (prev === undefined) delete process.env.TERMBRIDGE_TMUX_SOCKET;
			else process.env.TERMBRIDGE_TMUX_SOCKET = prev;
		}
	});

	it("two ensureSession calls on one instance overwrite the stored container (last wins)", async () => {
		const { exec, calls } = makeExec([
			{ code: 0 },
			{ code: 0 },
			{ code: 0 },
			{ code: 0 },
			{ code: 0, stdout: "x" },
		]);
		const env = new DockerEnvironment({ exec });
		await env.ensureSession({ ...baseOpts, name: "first" });
		await env.ensureSession({ ...baseOpts, name: "second" });
		await env.listSessions();
		// list-sessions targets the SECOND container.
		expect(calls[4]?.args[1]).toBe("termbridge-second");
	});
});

describe("DockerEnvironment HOME credentials mount (M4)", () => {
	it("bind-mounts an absolute HOME and passes it via -e", async () => {
		const { exec, calls } = makeExec();
		await new DockerEnvironment({ exec }).ensureSession({
			...baseOpts,
			env: { HOME: "/creds/home" },
		});
		const runArgs = calls[0]?.args ?? [];
		expect(runArgs).toContain("/creds/home:/creds/home");
		expect(runArgs).toContain("-e");
		expect(runArgs).toContain("HOME=/creds/home");
	});

	it("does not mount a non-absolute HOME", async () => {
		const { exec, calls } = makeExec();
		await new DockerEnvironment({ exec }).ensureSession({
			...baseOpts,
			env: { HOME: "relative" },
		});
		expect(calls[0]?.args).not.toContain("relative:relative");
	});
});
