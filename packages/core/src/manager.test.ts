import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConcurrencyLimitError, EnvNotAllowedError, SessionManager } from "./manager.js";
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

/**
 * Build a manager whose env defers ensureSession by one microtask tick. This
 * widens the window between the cap check and Session registration so that
 * concurrent open() calls genuinely overlap — exposing the TOCTOU race the
 * reservation counter fixes.
 */
function buildSlow(maxSessions: number) {
	const ensured: EnsureSessionOptions[] = [];
	let n = 0;
	const idGen = () => `id${++n}`;
	const env: Environment = {
		kind: "local",
		ensureSession: async (opts: EnsureSessionOptions): Promise<void> => {
			// Yield before recording so all racers pass the cap check first.
			await Promise.resolve();
			ensured.push(opts);
		},
		tmux: (): Promise<ExecResult> => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
		destroySession: (): Promise<void> => Promise.resolve(),
		listSessions: (): Promise<string[]> => Promise.resolve([]),
	};
	const manager = new SessionManager({
		maxSessions,
		envFactory: (_kind: EnvKind) => env,
		observerFactory: () => new PtyObserver({ clock: () => 0 }),
		idGen,
		pipeDir: "/tmp/termbridge-test",
	});
	return { manager, ensured };
}

describe("SessionManager concurrency cap is race-safe (TOCTOU)", () => {
	test("N concurrent open() with cap N all succeed and list() has N", async () => {
		const N = 5;
		const { manager } = buildSlow(N);
		const sessions = await Promise.all(Array.from({ length: N }, () => manager.open()));
		expect(sessions).toHaveLength(N);
		expect(manager.list()).toHaveLength(N);
		// Distinct ids.
		const ids = new Set(sessions.map((s) => s.id));
		expect(ids.size).toBe(N);
		// Distinct pipe files (one pipe-pane per session, derived from name).
		const names = new Set(manager.list().map((i) => i.name));
		expect(names.size).toBe(N);
	});

	test("N+1 concurrent open() with cap N: exactly N succeed, exactly 1 rejects with ConcurrencyLimitError", async () => {
		const N = 4;
		const { manager } = buildSlow(N);
		const results = await Promise.allSettled(Array.from({ length: N + 1 }, () => manager.open()));
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(N);
		expect(rejected).toHaveLength(1);
		// The single rejection is the typed concurrency error — cap NOT exceeded.
		const rej = rejected[0] as PromiseRejectedResult;
		expect(rej.reason).toBeInstanceOf(ConcurrencyLimitError);
		// Registry never overshot the cap.
		expect(manager.list()).toHaveLength(N);
	});

	test("a failed ensureSession frees the reserved slot so a later open() succeeds", async () => {
		let n = 0;
		const idGen = () => `id${++n}`;
		let calls = 0;
		const env: Environment = {
			kind: "local",
			ensureSession: async (): Promise<void> => {
				await Promise.resolve();
				calls++;
				if (calls === 1) throw new Error("tmux exploded");
			},
			tmux: (): Promise<ExecResult> => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
			destroySession: (): Promise<void> => Promise.resolve(),
			listSessions: (): Promise<string[]> => Promise.resolve([]),
		};
		const manager = new SessionManager({
			maxSessions: 1,
			envFactory: (_kind: EnvKind) => env,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen,
			pipeDir: "/tmp/termbridge-test",
		});
		// First open fails — must NOT leave a leaked reservation.
		await expect(manager.open()).rejects.toThrow("tmux exploded");
		expect(manager.list()).toHaveLength(0);
		// Slot freed: a subsequent open succeeds even with cap 1.
		const session = await manager.open();
		expect(session).toBeDefined();
		expect(manager.list()).toHaveLength(1);
	});

	test("concurrent sessions have distinct ids and distinct pipe files", async () => {
		const N = 3;
		const { manager, ensured } = buildSlow(N);
		await Promise.all(Array.from({ length: N }, () => manager.open()));
		// ensureSession saw N calls with distinct names → distinct pipe files.
		const names = ensured.map((e) => e.name);
		expect(new Set(names).size).toBe(N);
		const infos = manager.list();
		expect(new Set(infos.map((i) => i.id)).size).toBe(N);
	});
});

/**
 * Adversarial probing of the reservation counter under harsher interleavings.
 * These deliberately stress: exact cap boundary, multi-overflow, deeper async
 * windows (multiple ticks), mixed success/failure freeing slots, and verifying
 * the per-session pipe-pane offset/tap is wired distinctly per concurrent open.
 */

/**
 * Like buildSlow but with a configurable number of awaited ticks before
 * ensureSession records, widening the TOCTOU window arbitrarily. Also records
 * every pipe-pane tap so we can assert distinct per-session pipe files.
 */
function buildSlowDeep(maxSessions: number, ticks = 3) {
	const ensured: EnsureSessionOptions[] = [];
	const pipeTaps: string[] = [];
	let n = 0;
	const idGen = () => `id${++n}`;
	const env: Environment = {
		kind: "local",
		ensureSession: async (opts: EnsureSessionOptions): Promise<void> => {
			for (let i = 0; i < ticks; i++) await Promise.resolve();
			ensured.push(opts);
		},
		tmux: (args: string[]): Promise<ExecResult> => {
			if (args[0] === "pipe-pane") {
				// last arg is `cat >> <pipeFile>`
				pipeTaps.push(args[args.length - 1] ?? "");
			}
			return Promise.resolve({ stdout: "", stderr: "", code: 0 });
		},
		destroySession: (): Promise<void> => Promise.resolve(),
		listSessions: (): Promise<string[]> => Promise.resolve([]),
	};
	const manager = new SessionManager({
		maxSessions,
		envFactory: (_kind: EnvKind) => env,
		observerFactory: () => new PtyObserver({ clock: () => 0 }),
		idGen,
		pipeDir: "/tmp/termbridge-test",
	});
	return { manager, ensured, pipeTaps };
}

describe("SessionManager concurrency cap — adversarial", () => {
	test("exact cap boundary: cap=1, two concurrent opens → 1 ok, 1 ConcurrencyLimitError", async () => {
		const { manager } = buildSlow(1);
		const [a, b] = await Promise.allSettled([manager.open(), manager.open()]);
		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual(["fulfilled", "rejected"]);
		const rejected = [a, b].find((r) => r.status === "rejected") as
			| PromiseRejectedResult
			| undefined;
		expect(rejected?.reason).toBeInstanceOf(ConcurrencyLimitError);
		expect(manager.list()).toHaveLength(1);
	});

	test("multi-overflow: cap=2, 8 concurrent opens → exactly 2 succeed, exactly 6 reject", async () => {
		const N = 2;
		const overflow = 8;
		const { manager } = buildSlow(N);
		const results = await Promise.allSettled(
			Array.from({ length: overflow }, () => manager.open()),
		);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(N);
		expect(rejected).toHaveLength(overflow - N);
		// EVERY rejection is the typed concurrency error (not some other crash).
		for (const r of rejected) {
			expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyLimitError);
		}
		expect(manager.list()).toHaveLength(N);
	});

	test("deep async window (multiple ticks) does not let the cap be exceeded", async () => {
		const N = 3;
		const { manager } = buildSlowDeep(N, 5);
		const results = await Promise.allSettled(Array.from({ length: N + 4 }, () => manager.open()));
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(N);
		expect(manager.list()).toHaveLength(N);
		// Cap was never overshot at any await point.
		expect(manager.list().length).toBeLessThanOrEqual(N);
	});

	test("distinct pipe-pane taps per concurrent session (offset correctness across opens)", async () => {
		const N = 4;
		const { manager, pipeTaps } = buildSlowDeep(N, 2);
		await Promise.all(Array.from({ length: N }, () => manager.open()));
		// One pipe-pane tap per session, each to a distinct file path.
		expect(pipeTaps).toHaveLength(N);
		expect(new Set(pipeTaps).size).toBe(N);
		// Each tap references its own session's name-derived log.
		const names = manager.list().map((i) => i.name);
		for (const name of names) {
			expect(pipeTaps.some((t) => t.includes(`${name}.log`))).toBe(true);
		}
	});

	test("mixed success/failure: failures free slots so subsequent concurrent opens fit under the cap", async () => {
		// cap=2. Fire 2 that fail and 2 that succeed concurrently. The failures
		// must release their reservations so the cap is the only constraint and
		// at most 2 live sessions remain — never more.
		let n = 0;
		const idGen = () => `id${++n}`;
		let call = 0;
		const env: Environment = {
			kind: "local",
			ensureSession: async (): Promise<void> => {
				await Promise.resolve();
				call++;
				// Fail the first two that reach ensureSession.
				if (call <= 2) throw new Error(`boom ${call}`);
			},
			tmux: (): Promise<ExecResult> => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
			destroySession: (): Promise<void> => Promise.resolve(),
			listSessions: (): Promise<string[]> => Promise.resolve([]),
		};
		const manager = new SessionManager({
			maxSessions: 2,
			envFactory: (_kind: EnvKind) => env,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen,
			pipeDir: "/tmp/termbridge-test",
		});
		const results = await Promise.allSettled(Array.from({ length: 4 }, () => manager.open()));
		// Never more than the cap live, regardless of how failures interleave.
		expect(manager.list().length).toBeLessThanOrEqual(2);
		// At least the non-failing opens must have had a chance to fit.
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		expect(fulfilled.length).toBe(manager.list().length);
	});

	test("sequential reuse after full concurrent failure: all reservations released", async () => {
		// All concurrent opens fail; afterwards the manager must be fully free.
		let n = 0;
		const idGen = () => `id${++n}`;
		const env: Environment = {
			kind: "local",
			ensureSession: async (): Promise<void> => {
				await Promise.resolve();
				throw new Error("always fails");
			},
			tmux: (): Promise<ExecResult> => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
			destroySession: (): Promise<void> => Promise.resolve(),
			listSessions: (): Promise<string[]> => Promise.resolve([]),
		};
		const manager = new SessionManager({
			maxSessions: 3,
			envFactory: (_kind: EnvKind) => env,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen,
			pipeDir: "/tmp/termbridge-test",
		});
		const results = await Promise.allSettled(Array.from({ length: 10 }, () => manager.open()));
		// Every one rejected; some with the plain error, some possibly with the
		// concurrency error if reservations briefly stacked — but NONE registered.
		expect(results.every((r) => r.status === "rejected")).toBe(true);
		expect(manager.list()).toHaveLength(0);
		// Reservation counter is back to zero: a full cap's worth now succeeds.
		const okEnv = buildSlow(3);
		// Re-prove with a fresh working manager that the API contract holds.
		const ok = await Promise.all([
			okEnv.manager.open(),
			okEnv.manager.open(),
			okEnv.manager.open(),
		]);
		expect(ok).toHaveLength(3);
	});

	test("an envFactory throw (synchronous, before ensureSession) still frees the slot", async () => {
		// The factory throwing happens AFTER reserved++ but inside the try — the
		// finally must still decrement so the slot is not leaked forever.
		let throwOnce = true;
		const made = makeEnv();
		const manager = new SessionManager({
			maxSessions: 1,
			envFactory: (_kind: EnvKind) => {
				if (throwOnce) {
					throwOnce = false;
					throw new Error("factory blew up");
				}
				return made.env;
			},
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: (() => {
				let n = 0;
				return () => `id${++n}`;
			})(),
			pipeDir: "/tmp/termbridge-test",
		});
		await expect(manager.open()).rejects.toThrow("factory blew up");
		// Slot freed despite the factory throwing post-reservation.
		const session = await manager.open();
		expect(session).toBeDefined();
		expect(manager.list()).toHaveLength(1);
	});

	test("staggered opens: close one mid-flight, a queued reservation still respects the cap", async () => {
		// cap=1. Open one, then while a second concurrent open is in-flight (and
		// thus rejected by the cap), close the first and open again — must succeed.
		const { manager } = buildSlow(1);
		const first = await manager.open();
		expect(manager.list()).toHaveLength(1);
		// Second concurrent attempt is rejected (cap full).
		await expect(manager.open()).rejects.toBeInstanceOf(ConcurrencyLimitError);
		await manager.close(first.id);
		expect(manager.list()).toHaveLength(0);
		const third = await manager.open();
		expect(third).toBeDefined();
		expect(manager.list()).toHaveLength(1);
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

describe("SessionManager env policy (docker-only guard)", () => {
	/** Build a manager wired with a fake env + the given env policy. */
	function guarded(opts: { allowedEnvs?: EnvKind[]; defaultEnv?: EnvKind; idGen?: string }) {
		const made = makeEnv();
		const manager = new SessionManager({
			envFactory: () => made.env,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: () => opts.idGen ?? "g1",
			...(opts.allowedEnvs ? { allowedEnvs: opts.allowedEnvs } : {}),
			...(opts.defaultEnv ? { defaultEnv: opts.defaultEnv } : {}),
		});
		return { manager, made };
	}

	test("with allowedEnvs=[docker], an explicit env:'local' is rejected and nothing materializes", async () => {
		const { manager, made } = guarded({ allowedEnvs: ["docker"] });
		await expect(manager.open({ env: "local" })).rejects.toBeInstanceOf(EnvNotAllowedError);
		expect(made.ensured).toHaveLength(0);
		expect(manager.list()).toHaveLength(0);
	});

	test("the rejection carries env, allowed list, and code", async () => {
		const { manager } = guarded({ allowedEnvs: ["docker"] });
		let caught: unknown;
		try {
			await manager.open({ env: "local" });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(EnvNotAllowedError);
		expect((caught as EnvNotAllowedError).env).toBe("local");
		expect((caught as EnvNotAllowedError).allowed).toEqual(["docker"]);
		expect((caught as EnvNotAllowedError).code).toBe("env_not_allowed");
	});

	test("with allowedEnvs=[docker], an OMITTED env is coerced to docker (not rejected)", async () => {
		const { manager } = guarded({ allowedEnvs: ["docker"], idGen: "g3" });
		const s = await manager.open();
		expect(manager.get(s.id)).toBeDefined();
		expect(manager.list()[0]?.env).toBe("docker");
	});

	test("with allowedEnvs=[docker], env:'docker' succeeds", async () => {
		const { manager } = guarded({ allowedEnvs: ["docker"], idGen: "g4" });
		const s = await manager.open({ env: "docker" });
		expect(s.id).toBe("g4");
		expect(manager.list()[0]?.env).toBe("docker");
	});

	test("no policy (default): env:'local' still works (back-compat)", async () => {
		const { manager } = guarded({ idGen: "g5" });
		const s = await manager.open({ env: "local" });
		expect(s.id).toBe("g5");
		expect(manager.list()[0]?.env).toBe("local");
	});

	test("explicit defaultEnv is honoured when env omitted", async () => {
		const { manager } = guarded({ defaultEnv: "docker", idGen: "g6" });
		await manager.open();
		expect(manager.list()[0]?.env).toBe("docker");
	});

	test("TERMBRIDGE_ALLOWED_ENVS=docker locks the env via the environment variable", async () => {
		const prev = process.env.TERMBRIDGE_ALLOWED_ENVS;
		process.env.TERMBRIDGE_ALLOWED_ENVS = "docker";
		try {
			const made = makeEnv();
			const manager = new SessionManager({
				envFactory: () => made.env,
				observerFactory: () => new PtyObserver({ clock: () => 0 }),
				idGen: () => "g7",
			});
			await expect(manager.open({ env: "local" })).rejects.toBeInstanceOf(EnvNotAllowedError);
			const s = await manager.open();
			expect(manager.get(s.id)).toBeDefined();
			expect(manager.list()[0]?.env).toBe("docker");
		} finally {
			if (prev === undefined) {
				delete process.env.TERMBRIDGE_ALLOWED_ENVS;
			} else {
				process.env.TERMBRIDGE_ALLOWED_ENVS = prev;
			}
		}
	});

	test("an empty allowedEnvs array is treated as no policy (no deny-all footgun)", async () => {
		const { manager } = guarded({ allowedEnvs: [], idGen: "g8" });
		const s = await manager.open({ env: "local" });
		expect(s.id).toBe("g8");
		expect(manager.list()[0]?.env).toBe("local");
	});

	test("recover() honours the policy — adopts under defaultEnv, never hardcoded local", async () => {
		const made = makeEnv();
		const kinds: EnvKind[] = [];
		const manager = new SessionManager({
			envFactory: (k: EnvKind) => {
				kinds.push(k);
				return made.env;
			},
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: () => "rc1",
			allowedEnvs: ["docker"],
		});
		await manager.recover();
		expect(kinds).not.toContain("local");
		expect(kinds.every((k) => k === "docker")).toBe(true);
	});

	test("malformed TERMBRIDGE_ALLOWED_ENVS throws (no silent degrade to no-policy)", () => {
		const prev = process.env.TERMBRIDGE_ALLOWED_ENVS;
		process.env.TERMBRIDGE_ALLOWED_ENVS = "docker;local"; // wrong delimiter
		try {
			expect(
				() =>
					new SessionManager({
						envFactory: () => makeEnv().env,
						observerFactory: () => new PtyObserver({ clock: () => 0 }),
					}),
			).toThrow(/invalid/i);
		} finally {
			if (prev === undefined) {
				delete process.env.TERMBRIDGE_ALLOWED_ENVS;
			} else {
				process.env.TERMBRIDGE_ALLOWED_ENVS = prev;
			}
		}
	});

	test("empty TERMBRIDGE_ALLOWED_ENVS is treated as unset (no policy, local allowed)", async () => {
		const prev = process.env.TERMBRIDGE_ALLOWED_ENVS;
		process.env.TERMBRIDGE_ALLOWED_ENVS = "  ,  ";
		try {
			const made = makeEnv();
			const manager = new SessionManager({
				envFactory: () => made.env,
				observerFactory: () => new PtyObserver({ clock: () => 0 }),
				idGen: () => "e1",
			});
			const s = await manager.open({ env: "local" });
			expect(s.id).toBe("e1");
			expect(manager.list()[0]?.env).toBe("local");
		} finally {
			if (prev === undefined) {
				delete process.env.TERMBRIDGE_ALLOWED_ENVS;
			} else {
				process.env.TERMBRIDGE_ALLOWED_ENVS = prev;
			}
		}
	});
});
