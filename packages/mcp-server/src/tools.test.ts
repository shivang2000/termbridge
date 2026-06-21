// Unit tests for the §6 tool specs. They exercise createToolSpecs against a real
// SessionManager wired with a FAKE Environment (records calls, never touches real
// tmux/docker — mirrors packages/core/src/manager.test.ts makeEnv), a no-op
// observerFactory, and a deterministic idGen. No MCP SDK / transport here — these
// test the handler layer in isolation.

import { describe, expect, test } from "bun:test";
import {
	type EnsureSessionOptions,
	type Environment,
	type EnvKind,
	type ExecResult,
	PtyObserver,
	SessionManager,
	type TermSize,
} from "@termbridge/core";
import { createToolSpecs, type ToolSpec } from "./tools.js";

/** A fake Environment that records lifecycle calls and never touches tmux. */
function makeEnv(captureStdout = ""): {
	env: Environment;
	tmuxCalls: string[][];
	destroyed: string[];
} {
	const tmuxCalls: string[][] = [];
	const destroyed: string[] = [];
	const env: Environment = {
		kind: "local",
		ensureSession: (_opts: EnsureSessionOptions): Promise<void> => Promise.resolve(),
		tmux: (args: string[]): Promise<ExecResult> => {
			tmuxCalls.push(args);
			// capture-pane -p returns the scripted screen contents.
			const stdout = args[0] === "capture-pane" ? captureStdout : "";
			return Promise.resolve({ stdout, stderr: "", code: 0 });
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
	return { env, tmuxCalls, destroyed };
}

/** Build a manager wired with a fake env + a no-op observer + deterministic ids. */
function buildManager(captureStdout = "") {
	const made = makeEnv(captureStdout);
	let n = 0;
	const manager = new SessionManager({
		envFactory: (_kind: EnvKind) => made.env,
		observerFactory: () => new PtyObserver({ clock: () => 0 }),
		idGen: () => `id${++n}`,
		pipeDir: "/tmp/termbridge-mcp-test",
	});
	return { manager, made };
}

/** Find a spec by name (throws if missing — keeps tests honest about the surface). */
function spec(specs: ToolSpec[], name: string): ToolSpec {
	const found = specs.find((s) => s.name === name);
	if (!found) throw new Error(`tool spec not found: ${name}`);
	return found;
}

describe("createToolSpecs — surface", () => {
	test("exposes the full §6 tool set", () => {
		const { manager } = buildManager();
		const names = createToolSpecs(manager)
			.map((s) => s.name)
			.sort();
		expect(names).toEqual(
			[
				"close_session",
				"list_sessions",
				"open_session",
				"read_events",
				"read_new_output",
				"read_progress",
				"read_screen",
				"resize",
				"send_control",
				"send_text",
				"wait_for_event",
				"wait_for_idle",
				"wait_for_text",
			].sort(),
		);
	});
});

describe("createToolSpecs — handlers", () => {
	test("open_session returns { id, name, env }", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const res = (await spec(specs, "open_session").handler({ env: "local", cwd: "/work" })) as {
			id: string;
			name: string;
			env: string;
		};
		expect(res.id).toBe("id1");
		expect(res.name).toBe("tb-id1");
		expect(res.env).toBe("local");
	});

	test("open_session defaults env to 'local' when unspecified", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const res = (await spec(specs, "open_session").handler({})) as { env: string };
		expect(res.env).toBe("local");
	});

	test("list_sessions returns the registry snapshot", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		await spec(specs, "open_session").handler({});
		const res = (await spec(specs, "list_sessions").handler({})) as {
			sessions: Array<{ id: string; state: string }>;
		};
		expect(res.sessions).toHaveLength(1);
		expect(res.sessions[0]?.id).toBe("id1");
		expect(res.sessions[0]?.state).toBe("running");
	});

	test("send_text routes to the session and returns { ok:true }", async () => {
		const { manager, made } = buildManager();
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const res = (await spec(specs, "send_text").handler({
			id: opened.id,
			text: "hello",
			enter: true,
		})) as { ok: boolean };
		expect(res.ok).toBe(true);
		// send-keys -l <text> was issued to the fake env.
		const sent = made.tmuxCalls.find((c) => c[0] === "send-keys" && c.includes("hello"));
		expect(sent).toBeDefined();
	});

	test("read_screen returns the fake env's capture-pane stdout", async () => {
		const { manager } = buildManager("SCREEN-CONTENTS-XYZ");
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const res = (await spec(specs, "read_screen").handler({ id: opened.id })) as {
			screen: string;
		};
		expect(res.screen).toBe("SCREEN-CONTENTS-XYZ");
	});

	test("resize returns { ok:true }", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const res = (await spec(specs, "resize").handler({
			id: opened.id,
			cols: 120,
			rows: 40,
		})) as { ok: boolean };
		expect(res.ok).toBe(true);
	});

	test("close_session returns { ok:true } and deregisters", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const res = (await spec(specs, "close_session").handler({ id: opened.id })) as {
			ok: boolean;
		};
		expect(res.ok).toBe(true);
		expect(manager.get(opened.id)).toBeUndefined();
	});
});

describe("createToolSpecs — unknown id", () => {
	const targeted = [
		"send_text",
		"send_control",
		"read_screen",
		"read_new_output",
		"read_progress",
		"wait_for_idle",
		"wait_for_text",
		"read_events",
		"resize",
	];

	for (const name of targeted) {
		test(`${name} throws 'session not found' for an unknown id`, async () => {
			const { manager } = buildManager();
			const specs = createToolSpecs(manager);
			await expect(
				spec(specs, name).handler({
					id: "ghost",
					text: "x",
					key: "C-c",
					pattern: "p",
					cols: 1,
					rows: 1,
				}),
			).rejects.toThrow("session not found: ghost");
		});
	}
});

describe("createToolSpecs — read_progress", () => {
	/** A stub session exposing exactly the methods read_progress composes. */
	function stub(o: {
		delta: string;
		nextOffset: number;
		events?: unknown[];
		screen: string;
		lastActivityAt?: number;
	}): SessionManager {
		return {
			get: () => ({
				readNewOutput: (_o: { sinceOffset?: number }) => ({
					data: o.delta,
					nextOffset: o.nextOffset,
				}),
				readEvents: async () => ({ events: o.events ?? [], nextOffset: o.nextOffset }),
				readScreen: async () => o.screen,
				lastActivityAt: () => o.lastActivityAt ?? 0,
			}),
		} as unknown as SessionManager;
	}

	test("idle:true when no new output AND the current screen has no active phase", async () => {
		const specs = createToolSpecs(
			stub({ delta: "", nextOffset: 5, screen: "", lastActivityAt: 1234 }),
		);
		const res = (await spec(specs, "read_progress").handler({ id: "any", sinceOffset: 5 })) as {
			delta: string;
			nextOffset: number;
			events: unknown[];
			phase: string | null;
			awaitingInput: boolean;
			idle: boolean;
			lastActivityAt: number;
		};
		expect(res.delta).toBe("");
		expect(res.nextOffset).toBe(5);
		expect(res.events).toHaveLength(0);
		expect(res.phase).toBeNull();
		expect(res.awaitingInput).toBe(false);
		expect(res.idle).toBe(true);
		expect(res.lastActivityAt).toBe(1234);
	});

	test("idle:false when new output arrived", async () => {
		const specs = createToolSpecs(
			stub({
				delta: "new bytes",
				nextOffset: 9,
				screen: "",
				events: [{ kind: "claude-activity", data: { phase: "tool" }, suggestedKeys: [] }],
			}),
		);
		const res = (await spec(specs, "read_progress").handler({ id: "any" })) as {
			delta: string;
			idle: boolean;
			events: Array<{ kind: string }>;
		};
		expect(res.delta).toBe("new bytes");
		expect(res.idle).toBe(false);
		expect(res.events[0]?.kind).toBe("claude-activity");
	});

	test("idle:false + awaitingInput:true on a pre-painted permission prompt with NO new bytes", async () => {
		// The loop-breaking case: nothing new since the cursor, but the screen is
		// blocked on an approval. Empty-delta must NOT read as done.
		const screen = "● Update(app.ts)\nDo you want to make this edit?\n❯ 1. Yes\n  2. No\n";
		const specs = createToolSpecs(stub({ delta: "", nextOffset: 7, screen }));
		const res = (await spec(specs, "read_progress").handler({ id: "any", sinceOffset: 7 })) as {
			phase: string | null;
			awaitingInput: boolean;
			idle: boolean;
		};
		expect(res.phase).toBe("awaiting_input");
		expect(res.awaitingInput).toBe(true);
		expect(res.idle).toBe(false);
	});

	test("idle:false on an active spinner with NO new bytes (thinking pause)", async () => {
		const screen = "✻ Cogitating… (6s · esc to interrupt)\n";
		const specs = createToolSpecs(stub({ delta: "", nextOffset: 3, screen }));
		const res = (await spec(specs, "read_progress").handler({ id: "any", sinceOffset: 3 })) as {
			phase: string | null;
			idle: boolean;
		};
		expect(res.phase).toBe("thinking");
		expect(res.idle).toBe(false);
	});
});

describe("createToolSpecs — wait_for_event", () => {
	test("returns { timedOut:false } with the matching event when one is ready", async () => {
		// Stub manager whose session resolves an event immediately.
		const stubManager = {
			get: () => ({
				readEvents: async () => ({
					events: [{ kind: "needs_login", at: 1 }],
					nextOffset: 7,
				}),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({ id: "any" })) as {
			events: Array<{ kind: string }>;
			timedOut: boolean;
			nextOffset: number;
		};
		expect(res.timedOut).toBe(false);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]?.kind).toBe("needs_login");
		expect(res.nextOffset).toBe(7);
	});

	test("filters by kinds — non-matching events do not satisfy the wait", async () => {
		// readEvents always returns a non-matching event; with kinds set + tiny
		// timeout the poll must give up with timedOut:true.
		const stubManager = {
			get: () => ({
				readEvents: async () => ({
					events: [{ kind: "human_took_over", at: 1 }],
					nextOffset: 3,
				}),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			kinds: ["needs_login"],
			timeoutMs: 30,
		})) as { events: unknown[]; timedOut: boolean };
		expect(res.timedOut).toBe(true);
		expect(res.events).toHaveLength(0);
	});

	test("returns { timedOut:true } quickly when no events arrive", async () => {
		const stubManager = {
			get: () => ({
				readEvents: async () => ({ events: [], nextOffset: 0 }),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			timeoutMs: 30,
		})) as { events: unknown[]; timedOut: boolean };
		expect(res.timedOut).toBe(true);
		expect(res.events).toHaveLength(0);
	});

	test("throws 'session not found' for an unknown id", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		await expect(
			spec(specs, "wait_for_event").handler({ id: "ghost", timeoutMs: 30 }),
		).rejects.toThrow("session not found: ghost");
	});

	// ---- adversarial edge cases ----

	test("matches when ONE of several events matches the kinds filter", async () => {
		// A batch with mixed kinds — only the matching ones come back.
		const stubManager = {
			get: () => ({
				readEvents: async () => ({
					events: [
						{ kind: "human_took_over", at: 1 },
						{ kind: "needs_login", at: 2 },
						{ kind: "claude_permission", at: 3 },
					],
					nextOffset: 9,
				}),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			kinds: ["needs_login", "claude_permission"],
		})) as { events: Array<{ kind: string }>; timedOut: boolean; nextOffset: number };
		expect(res.timedOut).toBe(false);
		expect(res.events).toHaveLength(2);
		expect(res.events.map((e) => e.kind).sort()).toEqual(["claude_permission", "needs_login"]);
		expect(res.nextOffset).toBe(9);
	});

	test("empty kinds array matches NOTHING (kinds set but no kind is allowed)", async () => {
		// includes() on [] is always false, so an explicit empty kinds list can
		// never be satisfied — must time out rather than match.
		const stubManager = {
			get: () => ({
				readEvents: async () => ({
					events: [{ kind: "needs_login", at: 1 }],
					nextOffset: 4,
				}),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			kinds: [],
			timeoutMs: 30,
		})) as { events: unknown[]; timedOut: boolean };
		expect(res.timedOut).toBe(true);
		expect(res.events).toHaveLength(0);
	});

	test("advances sinceOffset across poll iterations (incremental cursor)", async () => {
		// First poll: empty, nextOffset 5. Second poll: must be called with
		// sinceOffset=5, then an event arrives. Proves the cursor is carried.
		const seen: Array<number | undefined> = [];
		let call = 0;
		const stubManager = {
			get: () => ({
				readEvents: async (opts: { sinceOffset?: number }) => {
					seen.push(opts.sinceOffset);
					call += 1;
					if (call === 1) return { events: [], nextOffset: 5 };
					return { events: [{ kind: "needs_login", at: 1 }], nextOffset: 11 };
				},
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			timeoutMs: 5000,
		})) as { events: unknown[]; timedOut: boolean; nextOffset: number };
		expect(res.timedOut).toBe(false);
		expect(res.nextOffset).toBe(11);
		// First read starts at 0; second read uses the advanced cursor.
		expect(seen[0]).toBe(0);
		expect(seen[1]).toBe(5);
	});

	test("timeoutMs:0 returns timedOut:true after a single poll with no match", async () => {
		// Boundary: Date.now()-start >= 0 is immediately true, so with no match on
		// the first read it returns timed-out without looping forever.
		let calls = 0;
		const stubManager = {
			get: () => ({
				readEvents: async () => {
					calls += 1;
					return { events: [], nextOffset: 2 };
				},
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			timeoutMs: 0,
		})) as { events: unknown[]; timedOut: boolean; nextOffset: number };
		expect(res.timedOut).toBe(true);
		expect(res.nextOffset).toBe(2);
		// Exactly one read happened — no busy-loop.
		expect(calls).toBe(1);
	});

	test("an immediate match wins even when timeoutMs is 0", async () => {
		// The match check precedes the deadline check, so a ready event is returned
		// even with a zero timeout.
		const stubManager = {
			get: () => ({
				readEvents: async () => ({
					events: [{ kind: "needs_login", at: 1 }],
					nextOffset: 6,
				}),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({
			id: "any",
			timeoutMs: 0,
		})) as { events: Array<{ kind: string }>; timedOut: boolean };
		expect(res.timedOut).toBe(false);
		expect(res.events).toHaveLength(1);
		expect(res.events[0]?.kind).toBe("needs_login");
	});

	test("defaults to a 30s deadline when timeoutMs is omitted (matches before)", async () => {
		// No timeoutMs → must still terminate by matching; verifies the default
		// path returns the event rather than throwing on missing timeout.
		const stubManager = {
			get: () => ({
				readEvents: async () => ({
					events: [{ kind: "needs_login", at: 1 }],
					nextOffset: 1,
				}),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "wait_for_event").handler({ id: "any" })) as {
			timedOut: boolean;
		};
		expect(res.timedOut).toBe(false);
	});
});

describe("createToolSpecs — human_driving passthrough", () => {
	test("send_text RETURNS { ok:false, error:'human_driving' } (does not throw)", async () => {
		// Stub manager whose get() returns a session refusing the agent write.
		const stubManager = {
			get: () => ({
				sendText: async () => ({ ok: false, error: "human_driving" }),
			}),
		} as unknown as SessionManager;
		const specs = createToolSpecs(stubManager);
		const res = (await spec(specs, "send_text").handler({ id: "any", text: "hi" })) as {
			ok: boolean;
			error?: string;
		};
		expect(res.ok).toBe(false);
		expect(res.error).toBe("human_driving");
	});
});
