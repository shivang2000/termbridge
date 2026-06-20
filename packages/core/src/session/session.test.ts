import { describe, expect, mock, test } from "bun:test";
import { PtyObserver } from "../observer/pty-observer.js";
import { RecognizerPipeline } from "../recognizers/pipeline.js";
import type { Clock, ExecResult, RecognizedEvent } from "../types.js";
import { Session, type SessionEnvironment } from "./session.js";
import { WriteLock } from "./write-lock.js";

/** Controllable fake clock. */
function makeClock(start = 0): {
	clock: Clock;
	set: (t: number) => void;
	advance: (ms: number) => void;
} {
	let now = start;
	return {
		clock: () => now,
		set: (t: number) => {
			now = t;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

/** Mock SessionEnvironment recording tmux argv and returning a scripted screen. */
function makeEnv(screen = ""): {
	env: SessionEnvironment;
	calls: string[][];
	setScreen: (s: string) => void;
	destroyed: string[];
} {
	let currentScreen = screen;
	const calls: string[][] = [];
	const destroyed: string[] = [];
	const env: SessionEnvironment = {
		tmux: (args: string[]): Promise<ExecResult> => {
			calls.push(args);
			const isCapture = args[0] === "capture-pane";
			return Promise.resolve({
				stdout: isCapture ? currentScreen : "",
				stderr: "",
				code: 0,
			});
		},
		destroySession: (name: string): Promise<void> => {
			destroyed.push(name);
			return Promise.resolve();
		},
	};
	return { env, calls, setScreen: (s) => (currentScreen = s), destroyed };
}

interface BuildOpts {
	screen?: string;
	clock?: Clock;
	writeLock?: WriteLock;
	observer?: PtyObserver;
	pipeline?: RecognizerPipeline;
}

function build(opts: BuildOpts = {}) {
	const clock = opts.clock ?? makeClock(0).clock;
	const envh = makeEnv(opts.screen ?? "");
	const observer = opts.observer ?? new PtyObserver({ clock });
	const pipeline = opts.pipeline ?? new RecognizerPipeline();
	const writeLock = opts.writeLock ?? new WriteLock({ clock });
	const sleep = mock((_ms: number) => Promise.resolve());
	const session = new Session({
		name: "s1",
		env: envh.env,
		observer,
		pipeline,
		writeLock,
		clock,
		sleep: sleep as unknown as (ms: number) => Promise<void>,
		pollMs: 5,
	});
	return { session, envh, observer, pipeline, writeLock, sleep };
}

describe("Session.sendText", () => {
	test("agent write sends literal text then Enter by default", async () => {
		const { session, envh } = build();
		const res = await session.sendText("hello");
		expect(res).toEqual({ ok: true });
		expect(envh.calls).toEqual([
			["send-keys", "-t", "s1", "-l", "hello"],
			["send-keys", "-t", "s1", "Enter"],
		]);
	});

	test("enter:false omits the trailing Enter", async () => {
		const { session, envh } = build();
		await session.sendText("partial", { enter: false });
		expect(envh.calls).toEqual([["send-keys", "-t", "s1", "-l", "partial"]]);
	});

	test("is refused while a human is driving (WriteLock gate) and sends nothing", async () => {
		const clock = makeClock(0);
		const writeLock = new WriteLock({ clock: clock.clock });
		writeLock.noteHumanActivity(); // human active
		const { session, envh } = build({ clock: clock.clock, writeLock });
		const res = await session.sendText("nope");
		expect(res).toEqual({ ok: false, error: "human_driving" });
		expect(envh.calls).toEqual([]); // no tmux issued
	});

	test("a refused write queues a single human_took_over event for readEvents", async () => {
		const clock = makeClock(0);
		const writeLock = new WriteLock({ clock: clock.clock });
		writeLock.noteHumanActivity();
		const { session } = build({ clock: clock.clock, writeLock, screen: "idle" });

		await session.sendText("a");
		await session.sendText("b"); // still human-active, but takeover already announced

		const { events } = await session.readEvents();
		const takeovers = events.filter((e) => e.kind === "human_took_over");
		expect(takeovers).toHaveLength(1);
	});
});

describe("Session.sendControl", () => {
	test("sends a control key when the agent owns the lock", async () => {
		const { session, envh } = build();
		const res = await session.sendControl("C-c");
		expect(res).toEqual({ ok: true });
		expect(envh.calls).toEqual([["send-keys", "-t", "s1", "C-c"]]);
	});

	test("is gated by the WriteLock", async () => {
		const clock = makeClock(0);
		const writeLock = new WriteLock({ clock: clock.clock });
		writeLock.noteHumanActivity();
		const { session, envh } = build({ clock: clock.clock, writeLock });
		expect(await session.sendControl("C-c")).toEqual({ ok: false, error: "human_driving" });
		expect(envh.calls).toEqual([]);
	});
});

describe("Session.readScreen", () => {
	test("captures the visible pane", async () => {
		const { session, envh } = build({ screen: "the screen" });
		const out = await session.readScreen();
		expect(out).toBe("the screen");
		expect(envh.calls[0]).toEqual(["capture-pane", "-p", "-t", "s1"]);
	});

	test("includes scrollback when requested", async () => {
		const { session, envh } = build({ screen: "x" });
		await session.readScreen({ scrollback: 200 });
		expect(envh.calls[0]).toEqual(["capture-pane", "-p", "-t", "s1", "-S", "-200"]);
	});
});

describe("Session.readNewOutput", () => {
	test("reflects the observer rolling buffer and offset", async () => {
		const { session, observer } = build();
		observer.ingest("abc");
		expect(session.readNewOutput({ sinceOffset: 0 })).toEqual({ data: "abc", nextOffset: 3 });
		observer.ingest("def");
		expect(session.readNewOutput({ sinceOffset: 3 })).toEqual({ data: "def", nextOffset: 6 });
	});
});

describe("Session.waitForIdle", () => {
	test("resolves idle:true once quiet for quietMs (via injected clock)", async () => {
		const clock = makeClock(1000);
		const observer = new PtyObserver({ clock: clock.clock });
		observer.ingest("activity"); // lastActivity = 1000
		const { session, sleep } = build({ clock: clock.clock, observer });

		(
			sleep as unknown as { mockImplementation: (f: (ms: number) => Promise<void>) => void }
		).mockImplementation((ms: number) => {
			clock.advance(ms);
			return Promise.resolve();
		});

		const res = await session.waitForIdle(400, 30_000);
		expect(res.idle).toBe(true);
		expect(res.waitedMs).toBeGreaterThanOrEqual(400);
	});

	test("resolves idle:false at timeout when output keeps arriving", async () => {
		const clock = makeClock(0);
		const observer = new PtyObserver({ clock: clock.clock });
		const { session, sleep } = build({ clock: clock.clock, observer });

		(
			sleep as unknown as { mockImplementation: (f: (ms: number) => Promise<void>) => void }
		).mockImplementation((ms: number) => {
			clock.advance(ms);
			observer.ingest("more"); // refresh activity at the new time
			return Promise.resolve();
		});

		const res = await session.waitForIdle(400, 1000);
		expect(res.idle).toBe(false);
		expect(res.waitedMs).toBeGreaterThanOrEqual(1000);
	});

	test("returns immediately idle when already quiet past the threshold", async () => {
		const clock = makeClock(0);
		const observer = new PtyObserver({ clock: clock.clock });
		observer.ingest("x"); // lastActivity = 0
		clock.set(5000); // long quiet
		const { session } = build({ clock: clock.clock, observer });
		const res = await session.waitForIdle(400, 30_000);
		expect(res).toEqual({ idle: true, waitedMs: 0 });
	});
});

describe("Session.waitForText", () => {
	test("matches a string substring and returns the screen", async () => {
		const { session } = build({ screen: "Proceed? [y/n]" });
		const res = await session.waitForText("[y/n]", 1000);
		expect(res.matched).toBe(true);
		expect(res.screen).toBe("Proceed? [y/n]");
	});

	test("matches a RegExp", async () => {
		const { session } = build({ screen: "code: ABCD-1234" });
		const res = await session.waitForText(/[A-Z]{4}-\d{4}/, 1000);
		expect(res.matched).toBe(true);
	});

	test("returns matched:false at timeout (never hangs)", async () => {
		const clock = makeClock(0);
		const { session, sleep } = build({ clock: clock.clock, screen: "nothing relevant" });
		(
			sleep as unknown as { mockImplementation: (f: (ms: number) => Promise<void>) => void }
		).mockImplementation((ms: number) => {
			clock.advance(ms);
			return Promise.resolve();
		});
		const res = await session.waitForText("never appears", 200);
		expect(res.matched).toBe(false);
		expect(res.screen).toBe("nothing relevant");
	});
});

describe("Session.readEvents", () => {
	test("runs the pipeline over screen + recent bytes and advances offset", async () => {
		const pipeline = new RecognizerPipeline();
		pipeline.register({
			kind: "yn",
			match(screen: string): Omit<RecognizedEvent, "kind"> | null {
				return screen.includes("[y/n]") ? { data: { q: "ok" }, suggestedKeys: ["y"] } : null;
			},
		});
		const { session, observer } = build({ screen: "Continue? [y/n]", pipeline });
		observer.ingest("some bytes");

		const res = await session.readEvents({ sinceOffset: 0 });
		expect(res.events).toEqual([{ kind: "yn", data: { q: "ok" }, suggestedKeys: ["y"] }]);
		expect(res.nextOffset).toBe("some bytes".length);
	});

	test("returns no events when nothing matches", async () => {
		const { session } = build({ screen: "just a prompt $ " });
		const res = await session.readEvents();
		expect(res.events).toEqual([]);
	});
});

describe("Session.resize", () => {
	test("issues tmux resize-window with stringified dims", async () => {
		const { session, envh } = build();
		await session.resize(120, 30);
		expect(envh.calls[0]).toEqual(["resize-window", "-t", "s1", "-x", "120", "-y", "30"]);
	});
});

describe("Session.close", () => {
	test("stops the observer and destroys the tmux session", async () => {
		const { session, envh, observer } = build();
		const stopSpy = mock(() => {});
		observer.stop = stopSpy as unknown as typeof observer.stop;
		await session.close();
		expect(stopSpy).toHaveBeenCalled();
		expect(envh.destroyed).toEqual(["s1"]);
	});
});

describe("Session — web bridge surface (M5)", () => {
	test("readScreen({escapes}) adds capture-pane -e", async () => {
		const { session, envh } = build({ screen: "X" });
		await session.readScreen({ escapes: true });
		expect(envh.calls[0]).toEqual(["capture-pane", "-p", "-t", "s1", "-e"]);
	});

	test("sendHumanInput sends raw bytes literally and flips the agent to human_driving", async () => {
		const { session, envh } = build();
		await session.sendHumanInput("\x1b[A"); // up-arrow bytes
		expect(envh.calls[0]).toEqual(["send-keys", "-t", "s1", "-l", "\x1b[A"]);
		// human is now driving → the agent's next write is refused
		const res = await session.sendText("echo hi");
		expect(res).toEqual({ ok: false, error: "human_driving" });
	});

	test("noteHumanActivity alone refuses the agent write", async () => {
		const { session } = build();
		session.noteHumanActivity();
		expect(await session.sendText("x")).toEqual({ ok: false, error: "human_driving" });
	});

	test("onOutput receives observer chunks and unsubscribes", () => {
		const observer = new PtyObserver({ clock: makeClock(0).clock });
		const { session } = build({ observer });
		const got: string[] = [];
		const off = session.onOutput((c) => got.push(c));
		observer.ingest("hello");
		off();
		observer.ingest("after-unsub");
		expect(got).toEqual(["hello"]);
	});
});

describe("Session — web bridge surface (M5) ADVERSARIAL", () => {
	test("onOutput unsubscribe removes ONLY that callback; the other keeps receiving", () => {
		const observer = new PtyObserver({ clock: makeClock(0).clock });
		const { session } = build({ observer });
		const a: string[] = [];
		const b: string[] = [];
		const offA = session.onOutput((c) => a.push(c));
		session.onOutput((c) => b.push(c));
		observer.ingest("one");
		offA(); // remove only A
		observer.ingest("two");
		expect(a).toEqual(["one"]); // A stopped at unsubscribe
		expect(b).toEqual(["one", "two"]); // B unaffected
	});

	test("the SAME callback subscribed twice: one unsubscribe removes exactly one registration", () => {
		const observer = new PtyObserver({ clock: makeClock(0).clock });
		const { session } = build({ observer });
		const got: string[] = [];
		const cb = (c: string) => got.push(c);
		const off1 = session.onOutput(cb);
		session.onOutput(cb); // same fn, two registrations
		observer.ingest("x"); // delivered twice
		off1(); // removes only the first registration (indexOf finds first)
		observer.ingest("y"); // delivered once (one registration remains)
		expect(got).toEqual(["x", "x", "y"]);
	});

	test("calling an unsubscribe twice is harmless and does not remove a different callback", () => {
		const observer = new PtyObserver({ clock: makeClock(0).clock });
		const { session } = build({ observer });
		const a: string[] = [];
		const b: string[] = [];
		const offA = session.onOutput((c) => a.push(c));
		session.onOutput((c) => b.push(c));
		offA();
		offA(); // second call: indexOf returns -1 → no-op, must NOT splice B out
		observer.ingest("z");
		expect(a).toEqual([]);
		expect(b).toEqual(["z"]); // B still subscribed
	});

	test("sendHumanInput flips the agent to human_driving for BOTH sendText and sendControl", async () => {
		const { session, envh } = build();
		await session.sendHumanInput("typed");
		expect(envh.calls).toEqual([["send-keys", "-t", "s1", "-l", "typed"]]);
		expect(await session.sendText("agent")).toEqual({ ok: false, error: "human_driving" });
		expect(await session.sendControl("C-c")).toEqual({ ok: false, error: "human_driving" });
		// no further tmux beyond the single human send — both agent writes refused
		expect(envh.calls).toEqual([["send-keys", "-t", "s1", "-l", "typed"]]);
	});

	test("after the human window lapses the agent regains the lock (TTL expiry)", async () => {
		const clock = makeClock(0);
		const writeLock = new WriteLock({ clock: clock.clock, ttlMs: 3000 });
		const { session, envh } = build({ clock: clock.clock, writeLock });
		await session.sendHumanInput("h"); // human-active at t=0
		expect(await session.sendText("blocked")).toEqual({ ok: false, error: "human_driving" });
		clock.advance(3001); // window lapses
		const res = await session.sendText("now allowed", { enter: false });
		expect(res).toEqual({ ok: true });
		expect(envh.calls).toContainEqual(["send-keys", "-t", "s1", "-l", "now allowed"]);
	});

	test("sendHumanInput queues exactly one human_took_over even across repeated human input", async () => {
		const { session } = build({ screen: "idle" });
		await session.sendHumanInput("a");
		await session.sendHumanInput("b");
		// agent attempts and is refused — the takeover is announced once
		await session.sendText("x");
		await session.sendText("y");
		const { events } = await session.readEvents();
		expect(events.filter((e) => e.kind === "human_took_over")).toHaveLength(1);
	});
});
