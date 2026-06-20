import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrencyLimitError, SessionManager } from "./manager.js";
import { PtyObserver } from "./observer/pty-observer.js";
import type {
	EnsureSessionOptions,
	Environment,
	EnvKind,
	ExecFn,
	ExecResult,
	TermSize,
} from "./types.js";

/** A fake Environment that records lifecycle calls and never touches tmux. */
function makeEnv(): {
	env: Environment;
	ensured: EnsureSessionOptions[];
	tmuxCalls: string[][];
	destroyed: string[];
} {
	const ensured: EnsureSessionOptions[] = [];
	const tmuxCalls: string[][] = [];
	const destroyed: string[] = [];
	const env: Environment = {
		kind: "local",
		ensureSession: (opts: EnsureSessionOptions): Promise<void> => {
			ensured.push(opts);
			return Promise.resolve();
		},
		tmux: (args: string[]): Promise<ExecResult> => {
			tmuxCalls.push(args);
			return Promise.resolve({ stdout: "", stderr: "", code: 0 });
		},
		attachPty: (_n: string, _s: TermSize): unknown => {
			throw new Error("M5");
		},
		destroySession: (name: string): Promise<void> => {
			destroyed.push(name);
			return Promise.resolve();
		},
		listSessions: (): Promise<string[]> => Promise.resolve([]),
	};
	return { env, ensured, tmuxCalls, destroyed };
}

/** Build a manager wired with a fake env + a no-op observer + deterministic ids. */
function build(maxSessions = 4) {
	const made = makeEnv();
	let n = 0;
	const idGen = () => `id${++n}`;
	// Observer with no readAppended -> start() is a harmless no-op.
	const observerFactory = () => new PtyObserver({ clock: () => 0 });
	const manager = new SessionManager({
		maxSessions,
		envFactory: (_kind: EnvKind) => made.env,
		observerFactory,
		idGen,
		pipeDir: "/tmp/termbridge-test",
	});
	return { manager, made };
}

describe("SessionManager.open / lifecycle", () => {
	test("the returned Session carries the registry id", async () => {
		const { manager } = build();
		const session = await manager.open();
		expect(session.id).toBe("id1");
		expect(manager.list()[0]?.id).toBe("id1");
	});

	test("open returns a Session and registers it with running state", async () => {
		const { manager } = build();
		const session = await manager.open();
		expect(session).toBeDefined();
		const list = manager.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.state).toBe("running");
		expect(list[0]?.env).toBe("local");
		expect(list[0]?.id).toBe("id1");
	});

	test("open materializes the tmux session and wires pipe-pane", async () => {
		const { manager, made } = build();
		await manager.open({ cwd: "/work", cmd: "claude" });
		expect(made.ensured).toHaveLength(1);
		expect(made.ensured[0]?.cwd).toBe("/work");
		expect(made.ensured[0]?.cmd).toBe("claude");
		// pipe-pane -O was issued for the observer tap.
		const pipe = made.tmuxCalls.find((c) => c[0] === "pipe-pane");
		expect(pipe).toBeDefined();
		const ensured = made.ensured[0];
		if (!ensured) throw new Error("expected one ensured session");
		expect(pipe?.slice(0, 4)).toEqual(["pipe-pane", "-O", "-t", ensured.name]);
	});

	test("open uses a default name derived from the id when none given", async () => {
		const { manager, made } = build();
		await manager.open();
		expect(made.ensured[0]?.name).toBe("tb-id1");
	});

	test("open honours an explicit name", async () => {
		const { manager, made } = build();
		await manager.open({ name: "mysess" });
		expect(made.ensured[0]?.name).toBe("mysess");
		expect(manager.list()[0]?.name).toBe("mysess");
	});

	test("get returns the live session, undefined after close", async () => {
		const { manager } = build();
		const session = await manager.open();
		expect(manager.get("id1")).toBe(session);
		await manager.close("id1");
		expect(manager.get("id1")).toBeUndefined();
	});

	test("close destroys the underlying session and frees the slot", async () => {
		const { manager, made } = build(1);
		await manager.open({ name: "one" });
		await manager.close("id1");
		expect(made.destroyed).toEqual(["one"]);
		// Slot is freed: a new open succeeds.
		const again = await manager.open({ name: "two" });
		expect(again).toBeDefined();
		expect(manager.list()).toHaveLength(1);
	});

	test("close on an unknown id is a no-op", async () => {
		const { manager } = build();
		await expect(manager.close("ghost")).resolves.toBeUndefined();
	});

	test("list returns independent snapshots (mutating one does not affect registry)", async () => {
		const { manager } = build();
		await manager.open();
		const snap = manager.list();
		if (snap[0]) snap[0].state = "closed";
		expect(manager.list()[0]?.state).toBe("running");
	});
});

describe("SessionManager concurrency cap", () => {
	test("open past the cap throws ConcurrencyLimitError", async () => {
		const { manager } = build(2);
		await manager.open();
		await manager.open();
		await expect(manager.open()).rejects.toBeInstanceOf(ConcurrencyLimitError);
	});

	test("the thrown error carries the limit", async () => {
		const { manager } = build(1);
		await manager.open();
		let caught: unknown;
		try {
			await manager.open();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ConcurrencyLimitError);
		expect((caught as ConcurrencyLimitError).limit).toBe(1);
		expect((caught as ConcurrencyLimitError).code).toBe("concurrency_limit");
	});

	test("closing a session reopens a slot under the cap", async () => {
		const { manager } = build(1);
		await manager.open();
		await expect(manager.open()).rejects.toBeInstanceOf(ConcurrencyLimitError);
		await manager.close("id1");
		await expect(manager.open()).resolves.toBeDefined();
	});
});

describe("SessionManager env selection", () => {
	test("defaults to local when env is unspecified", async () => {
		const { manager } = build();
		await manager.open();
		expect(manager.list()[0]?.env).toBe("local");
	});

	test("default pipeDir honours TERMBRIDGE_PIPE_DIR", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tb-pipedir-test-"));
		const prev = process.env.TERMBRIDGE_PIPE_DIR;
		process.env.TERMBRIDGE_PIPE_DIR = dir;
		try {
			const made = makeEnv();
			let captured = "";
			const manager = new SessionManager({
				envFactory: (_kind, ctx) => {
					captured = ctx.pipeDir;
					return made.env;
				},
				observerFactory: () => new PtyObserver({ clock: () => 0 }),
				idGen: () => "p1",
			});
			await manager.open();
			expect(captured).toBe(dir);
		} finally {
			if (prev === undefined) delete process.env.TERMBRIDGE_PIPE_DIR;
			else process.env.TERMBRIDGE_PIPE_DIR = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("default factory builds a Docker environment for env:'docker' (mocked exec, no real container)", async () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		const exec = ((file: string, args: string[]) => {
			calls.push({ file, args });
			return Promise.resolve({ stdout: "", stderr: "", code: 0 });
		}) as unknown as ExecFn;
		const manager = new SessionManager({
			exec,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: () => "x",
			pipeDir: "/tmp/termbridge-test",
		});
		await manager.open({ env: "docker", cwd: "/work" });
		expect(manager.list()[0]?.env).toBe("docker");
		// Only the injected mock saw the docker CLI — no real container was spawned.
		expect(calls.some((c) => c.file === "docker" && c.args[0] === "run")).toBe(true);
		expect(calls.some((c) => c.file === "docker" && c.args.includes("new-session"))).toBe(true);
	});

	test("default factory rejects an unknown env", async () => {
		const manager = new SessionManager({
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: () => "x",
			pipeDir: "/tmp/termbridge-test",
		});
		await expect(manager.open({ env: "bogus" as EnvKind })).rejects.toThrow(/unknown environment/);
	});

	test("a failing ensureSession surfaces the error and does not register", async () => {
		const observerFactory = () => new PtyObserver({ clock: () => 0 });
		const boom: Environment = {
			kind: "local",
			ensureSession: () => Promise.reject(new Error("tmux exploded")),
			tmux: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
			destroySession: () => Promise.resolve(),
			listSessions: () => Promise.resolve([]),
		};
		const manager = new SessionManager({
			envFactory: () => boom,
			observerFactory,
			idGen: () => "x",
			pipeDir: "/tmp/termbridge-test",
		});
		await expect(manager.open()).rejects.toThrow("tmux exploded");
		expect(manager.list()).toEqual([]);
	});
});

describe("SessionManager auth + recognizer wiring (M4)", () => {
	test("sets HOME from the creds volume and queues needs_login when logged out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tb-home-test-"));
		try {
			const made = makeEnv();
			const manager = new SessionManager({
				homeDir: dir, // empty dir -> not logged in
				envFactory: () => made.env,
				observerFactory: () => new PtyObserver({ clock: () => 0 }),
				idGen: () => "h1",
			});
			const session = await manager.open();
			expect(made.ensured[0]?.env?.HOME).toBe(dir);
			const { events } = await session.readEvents();
			expect(events.some((e) => e.kind === "needs_login")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no auth provisioning (no HOME, no needs_login) when no creds volume", async () => {
		const prev = process.env.TERMBRIDGE_HOME;
		delete process.env.TERMBRIDGE_HOME;
		try {
			const made = makeEnv();
			const manager = new SessionManager({
				envFactory: () => made.env,
				observerFactory: () => new PtyObserver({ clock: () => 0 }),
				idGen: () => "n1",
			});
			const session = await manager.open();
			expect(made.ensured[0]?.env).toBeUndefined();
			const { events } = await session.readEvents();
			expect(events.some((e) => e.kind === "needs_login")).toBe(false);
		} finally {
			if (prev !== undefined) process.env.TERMBRIDGE_HOME = prev;
		}
	});

	test("registered recognizers fire through readEvents (generic-yn)", async () => {
		const made = makeEnv();
		made.env.tmux = (args: string[]) =>
			Promise.resolve(
				args[0] === "capture-pane"
					? { stdout: "Proceed? [y/N]", stderr: "", code: 0 }
					: { stdout: "", stderr: "", code: 0 },
			);
		const manager = new SessionManager({
			envFactory: () => made.env,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: () => "r1",
		});
		const session = await manager.open();
		const { events } = await session.readEvents();
		expect(events.some((e) => e.kind === "generic-yn")).toBe(true);
	});
});
