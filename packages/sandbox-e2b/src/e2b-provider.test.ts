// Mocked unit tests for E2BSandboxProvider — every E2B SDK call is behind an
// injectable sandboxFactory, so these NEVER touch a real cloud or real tmux.
import { describe, expect, it } from "bun:test";
import { E2BSandboxProvider } from "./e2b-provider.js";

interface CmdResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	error?: string;
}
interface MockSandbox {
	commands: { run: (cmd: string, opts?: { timeoutMs?: number }) => Promise<CmdResult> };
	kill: () => Promise<boolean>;
	sandboxId: string;
}
function makeMockFactory(results: CmdResult[] = [{ exitCode: 0, stdout: "", stderr: "" }]) {
	const createCalls: Array<{
		template?: string;
		envs?: Record<string, string>;
		apiKey?: string;
		timeoutMs?: number;
		metadata?: Record<string, string>;
	}> = [];
	const runCalls: string[] = [];
	let killCalls = 0;
	let i = 0;
	const sandbox: MockSandbox = {
		sandboxId: "sb-mock-1",
		commands: {
			run: async (cmd: string) => {
				runCalls.push(cmd);
				const last = results[results.length - 1];
				const r = results[i++] ?? last ?? { exitCode: 0, stdout: "", stderr: "" };
				if (r.exitCode !== 0) {
					const err = new Error(`Command exited with code ${r.exitCode}`) as Error & CmdResult;
					err.exitCode = r.exitCode;
					err.stdout = r.stdout;
					err.stderr = r.stderr;
					err.error = "non-zero exit";
					throw err;
				}
				return r;
			},
		},
		kill: async () => {
			killCalls++;
			return true;
		},
	};
	const sandboxFactory = async (opts: {
		template?: string;
		envs?: Record<string, string>;
		apiKey?: string;
		timeoutMs?: number;
		metadata?: Record<string, string>;
	}) => {
		createCalls.push(opts);
		return sandbox;
	};
	return {
		sandboxFactory,
		createCalls,
		runCalls,
		get killCalls() {
			return killCalls;
		},
	};
}

describe("E2BSandboxProvider", () => {
	it("has name 'e2b'", () => {
		const p = new E2BSandboxProvider({
			apiKey: "k",
			sandboxFactory: makeMockFactory().sandboxFactory,
		});
		expect(p.name).toBe("e2b");
	});
	it("ensure provisions a sandbox via the factory with template/envs/apiKey/metadata", async () => {
		const m = makeMockFactory();
		const p = new E2BSandboxProvider({
			apiKey: "k",
			template: "base",
			timeoutMs: 1000,
			sandboxFactory: m.sandboxFactory,
		});
		await p.ensure({ name: "sess", cwd: "/work", env: { FOO: "bar" } });
		expect(m.createCalls).toHaveLength(1);
		expect(m.createCalls[0]?.template).toBe("base");
		expect(m.createCalls[0]?.envs).toEqual({ FOO: "bar" });
		expect(m.createCalls[0]?.apiKey).toBe("k");
		expect(m.createCalls[0]?.timeoutMs).toBe(1000);
		expect(m.createCalls[0]?.metadata).toEqual({ name: "sess" });
		// install probe + verify probe (both mention tmux)
		expect(m.runCalls.length).toBeGreaterThanOrEqual(2);
		expect(m.runCalls[0]).toContain("tmux");
		expect(m.runCalls[0]).toContain("sudo -n");
		expect(m.runCalls[1]).toContain("command -v tmux");
	});
	it("ensure defaults apiKey to E2B_API_KEY env when not passed", async () => {
		process.env.E2B_API_KEY = "env-key";
		const m = makeMockFactory();
		const p = new E2BSandboxProvider({ sandboxFactory: m.sandboxFactory });
		await p.ensure({ name: "s", cwd: "/w" });
		expect(m.createCalls[0]?.apiKey).toBe("env-key");
		delete process.env.E2B_API_KEY;
	});
	it("exec shell-joins the argv and returns the result", async () => {
		const m = makeMockFactory([{ exitCode: 0, stdout: "hello", stderr: "" }]);
		const p = new E2BSandboxProvider({ apiKey: "k", sandboxFactory: m.sandboxFactory });
		await p.ensure({ name: "s", cwd: "/w" });
		const res = await p.exec([
			"tmux",
			"-L",
			"termbridge",
			"list-sessions",
			"-F",
			"#{session_name}",
		]);
		expect(res).toEqual({ stdout: "hello", stderr: "", code: 0 });
		expect(m.runCalls[m.runCalls.length - 1]).toContain("tmux");
		expect(m.runCalls[m.runCalls.length - 1]).toContain("list-sessions");
	});
	it("exec returns non-zero exit as DATA, not a throw (catches CommandExitError)", async () => {
		// ensure: install ok + probe ok; then exec fails with CommandExitError
		const m = makeMockFactory([
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "/usr/bin/tmux", stderr: "" },
			{ exitCode: 1, stdout: "", stderr: "no server" },
		]);
		const p = new E2BSandboxProvider({ apiKey: "k", sandboxFactory: m.sandboxFactory });
		await p.ensure({ name: "s", cwd: "/w" });
		const res = await p.exec(["tmux", "-L", "termbridge", "list-sessions"]);
		expect(res.code).toBe(1);
		expect(res.stderr).toBe("no server");
		expect(res.stdout).toBe("");
	});
	it("exec shell-quotes args containing spaces (cwd path)", async () => {
		const m = makeMockFactory([{ exitCode: 0, stdout: "", stderr: "" }]);
		const p = new E2BSandboxProvider({ apiKey: "k", sandboxFactory: m.sandboxFactory });
		await p.ensure({ name: "s", cwd: "/w" });
		await p.exec(["tmux", "new-session", "-c", "/path with space", "-s", "x"]);
		const cmd = m.runCalls[m.runCalls.length - 1] ?? "";
		expect(cmd).toContain("'/path with space'");
	});
	it("destroy kills the sandbox and swallows errors", async () => {
		const m = makeMockFactory();
		const p = new E2BSandboxProvider({ apiKey: "k", sandboxFactory: m.sandboxFactory });
		await p.ensure({ name: "s", cwd: "/w" });
		await p.destroy();
		expect(m.killCalls).toBe(1);
	});
	it("destroy before ensure is a no-op (no sandbox yet)", async () => {
		const m = makeMockFactory();
		const p = new E2BSandboxProvider({ apiKey: "k", sandboxFactory: m.sandboxFactory });
		await expect(p.destroy()).resolves.toBeUndefined();
		expect(m.killCalls).toBe(0);
	});

	it("ensure kills the sandbox when tmux install fails (no orphan)", async () => {
		const m = makeMockFactory([{ exitCode: 1, stdout: "", stderr: "apt failed" }]);
		const p = new E2BSandboxProvider({ apiKey: "k", sandboxFactory: m.sandboxFactory });
		await expect(p.ensure({ name: "s", cwd: "/w" })).rejects.toThrow(/failed to install tmux/);
		expect(m.killCalls).toBe(1);
		// After destroy, exec must refuse (sandbox cleared).
		await expect(p.exec(["true"])).rejects.toThrow(/before ensure/);
	});
});
