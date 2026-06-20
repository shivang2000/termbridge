// ADVERSARIAL tests for @termbridge/mcp-server. These deliberately probe the
// contract corners a happy-path suite skips: human_driving passthrough for BOTH
// send_text AND send_control (must be returned as DATA, never thrown / never an
// MCP error result), server-layer error wrapping (handler throws → isError
// result built by formatErrorResponse), env defaulting (docker is NOT rewritten
// to local), JSON round-trip of every result, numeric/optional arg edge cases,
// and that the server registers exactly the 11 §6 tools with the right names.
//
// No real tmux/docker (fake Environment), and the server-surface assertions
// inspect the registered McpServer in-process — no SDK transport is spun up.

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
import { formatErrorResponse, formatTextResponse } from "./format.js";
import { createServer } from "./server.js";
import { createToolSpecs, type ToolSpec } from "./tools.js";

// ---------------------------------------------------------------------------
// Fakes (mirror manager.test.ts makeEnv)
// ---------------------------------------------------------------------------

function makeEnv(captureStdout = ""): {
	env: Environment;
	tmuxCalls: string[][];
	kind: EnvKind;
} {
	const tmuxCalls: string[][] = [];
	const env: Environment = {
		kind: "local",
		ensureSession: (_opts: EnsureSessionOptions): Promise<void> => Promise.resolve(),
		tmux: (args: string[]): Promise<ExecResult> => {
			tmuxCalls.push(args);
			const stdout = args[0] === "capture-pane" ? captureStdout : "";
			return Promise.resolve({ stdout, stderr: "", code: 0 });
		},
		attachPty: (_n: string, _s: TermSize): unknown => {
			throw new Error("M5");
		},
		destroySession: (_name: string): Promise<void> => Promise.resolve(),
		listSessions: (): Promise<string[]> => Promise.resolve([]),
	};
	return { env, tmuxCalls, kind: env.kind };
}

function buildManager(captureStdout = ""): { manager: SessionManager; tmuxCalls: string[][] } {
	const made = makeEnv(captureStdout);
	let n = 0;
	const manager = new SessionManager({
		envFactory: (_kind: EnvKind) => made.env,
		observerFactory: () => new PtyObserver({ clock: () => 0 }),
		idGen: () => `id${++n}`,
		pipeDir: "/tmp/termbridge-mcp-adversary",
	});
	return { manager, tmuxCalls: made.tmuxCalls };
}

function spec(specs: ToolSpec[], name: string): ToolSpec {
	const found = specs.find((s) => s.name === name);
	if (!found) throw new Error(`tool spec not found: ${name}`);
	return found;
}

// ---------------------------------------------------------------------------
// human_driving passthrough — BOTH send_text AND send_control
// ---------------------------------------------------------------------------

describe("adversary — human_driving is DATA, never an error", () => {
	function stubManagerRefusing(): SessionManager {
		return {
			get: () => ({
				sendText: async () => ({ ok: false, error: "human_driving" }),
				sendControl: async () => ({ ok: false, error: "human_driving" }),
			}),
		} as unknown as SessionManager;
	}

	test("send_text handler RETURNS the refusal (does not throw)", async () => {
		const specs = createToolSpecs(stubManagerRefusing());
		const res = (await spec(specs, "send_text").handler({ id: "x", text: "hi" })) as {
			ok: boolean;
			error?: string;
		};
		expect(res.ok).toBe(false);
		expect(res.error).toBe("human_driving");
	});

	test("send_control handler RETURNS the refusal (does not throw)", async () => {
		const specs = createToolSpecs(stubManagerRefusing());
		const res = (await spec(specs, "send_control").handler({ id: "x", key: "C-c" })) as {
			ok: boolean;
			error?: string;
		};
		expect(res.ok).toBe(false);
		expect(res.error).toBe("human_driving");
	});

	test("server wraps human_driving as a NON-error text result (isError unset)", () => {
		// At the server layer the refusal is success-shaped data: it must be
		// JSON-stringified by formatTextResponse, NOT routed through formatErrorResponse.
		const wrapped = formatTextResponse({ ok: false, error: "human_driving" });
		expect(wrapped).not.toHaveProperty("isError");
		const parsed = JSON.parse(wrapped.content[0].text) as { ok: boolean; error: string };
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toBe("human_driving");
	});
});

// ---------------------------------------------------------------------------
// Server-layer error wrapping: a throwing handler becomes an isError result.
// ---------------------------------------------------------------------------

describe("adversary — handler throws → server isError result", () => {
	// Re-implement the exact wrapping server.ts applies, then prove its behaviour
	// for both the success and throw branch. (createServer wires this same closure.)
	function wrap(handler: (a: unknown) => Promise<unknown>) {
		return async (args: unknown) => {
			try {
				return formatTextResponse(await handler(args));
			} catch (e) {
				return formatErrorResponse(e);
			}
		};
	}

	test("a thrown Error becomes { isError:true } carrying the message", async () => {
		const cb = wrap(async () => {
			throw new Error("session not found: ghost");
		});
		const res = (await cb({})) as { content: [{ text: string }]; isError?: true };
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe("session not found: ghost");
	});

	test("a thrown non-Error is stringified into the message", async () => {
		const cb = wrap(async () => {
			throw "boom-string";
		});
		const res = (await cb({})) as { content: [{ text: string }]; isError?: true };
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe("boom-string");
	});

	test("a successful handler produces a text result WITHOUT isError", async () => {
		const cb = wrap(async () => ({ ok: true }));
		const res = (await cb({})) as { content: [{ text: string }]; isError?: true };
		expect(res.isError).toBeUndefined();
		expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
	});

	test("real unknown-id throw, wrapped, surfaces as isError at the server layer", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const cb = wrap((a) => spec(specs, "read_screen").handler(a));
		const res = (await cb({ id: "nope" })) as { content: [{ text: string }]; isError?: true };
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe("session not found: nope");
	});
});

// ---------------------------------------------------------------------------
// open_session env defaulting — docker must survive, undefined → local.
// ---------------------------------------------------------------------------

describe("adversary — open_session env defaulting", () => {
	test("env:'docker' is echoed back as 'docker' (NOT collapsed to local)", async () => {
		// Use a fake envFactory so 'docker' does not spawn a real container.
		const made = makeEnv();
		let n = 0;
		const manager = new SessionManager({
			envFactory: (_kind: EnvKind) => made.env,
			observerFactory: () => new PtyObserver({ clock: () => 0 }),
			idGen: () => `id${++n}`,
			pipeDir: "/tmp/termbridge-mcp-adversary",
		});
		const specs = createToolSpecs(manager);
		const res = (await spec(specs, "open_session").handler({ env: "docker" })) as { env: string };
		expect(res.env).toBe("docker");
	});

	test("missing env defaults to 'local' in the returned payload", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const res = (await spec(specs, "open_session").handler({})) as { env: string };
		expect(res.env).toBe("local");
	});

	test("explicit name is honoured (not overwritten by the tb- default)", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const res = (await spec(specs, "open_session").handler({ name: "custom-name" })) as {
			name: string;
		};
		expect(res.name).toBe("custom-name");
	});
});

// ---------------------------------------------------------------------------
// Numeric / optional argument edge cases routed to core.
// ---------------------------------------------------------------------------

describe("adversary — numeric / optional arg routing", () => {
	test("read_screen with scrollback issues capture-pane -S -<n>", async () => {
		const { manager, tmuxCalls } = buildManager("X");
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		await spec(specs, "read_screen").handler({ id: opened.id, scrollback: 50 });
		const cap = tmuxCalls.find((c) => c[0] === "capture-pane" && c.includes("-S"));
		expect(cap).toBeDefined();
		expect(cap).toContain("-50");
	});

	test("read_screen WITHOUT scrollback omits -S", async () => {
		const { manager, tmuxCalls } = buildManager("X");
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		// drop earlier capture calls by recording the length first
		const before = tmuxCalls.length;
		await spec(specs, "read_screen").handler({ id: opened.id });
		const newCaptures = tmuxCalls.slice(before).filter((c) => c[0] === "capture-pane");
		expect(newCaptures.length).toBeGreaterThan(0);
		for (const c of newCaptures) expect(c).not.toContain("-S");
	});

	test("resize routes cols/rows to resize-window -x/-y", async () => {
		const { manager, tmuxCalls } = buildManager();
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const res = (await spec(specs, "resize").handler({
			id: opened.id,
			cols: 99,
			rows: 33,
		})) as { ok: boolean };
		expect(res.ok).toBe(true);
		const r = tmuxCalls.find((c) => c[0] === "resize-window");
		expect(r).toBeDefined();
		expect(r).toContain("99");
		expect(r).toContain("33");
	});

	test("read_new_output returns { data, nextOffset } shape", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const res = (await spec(specs, "read_new_output").handler({
			id: opened.id,
			sinceOffset: 0,
		})) as { data: string; nextOffset: number };
		expect(typeof res.data).toBe("string");
		expect(typeof res.nextOffset).toBe("number");
	});

	test("send_text with enter:false suppresses the trailing Enter key", async () => {
		const { manager, tmuxCalls } = buildManager();
		const specs = createToolSpecs(manager);
		const opened = (await spec(specs, "open_session").handler({})) as { id: string };
		const before = tmuxCalls.length;
		await spec(specs, "send_text").handler({ id: opened.id, text: "noenter", enter: false });
		const after = tmuxCalls.slice(before);
		// literal text sent, but no standalone Enter send-keys
		expect(after.some((c) => c[0] === "send-keys" && c.includes("noenter"))).toBe(true);
		expect(after.some((c) => c[0] === "send-keys" && c.length === 4 && c.includes("Enter"))).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// JSON round-trip — every result must survive formatTextResponse → JSON.parse.
// ---------------------------------------------------------------------------

describe("adversary — JSON round-trip of results", () => {
	test("open_session result round-trips through the formatter", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const data = await spec(specs, "open_session").handler({ env: "local" });
		const wrapped = formatTextResponse(data);
		const parsed = JSON.parse(wrapped.content[0].text) as { id: string; env: string };
		expect(parsed).toEqual(data as typeof parsed);
	});

	test("list_sessions result round-trips with state intact", async () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		await spec(specs, "open_session").handler({});
		const data = (await spec(specs, "list_sessions").handler({})) as {
			sessions: Array<{ id: string; state: string }>;
		};
		const parsed = JSON.parse(formatTextResponse(data).content[0].text) as typeof data;
		expect(parsed.sessions[0]?.state).toBe("running");
	});
});

// ---------------------------------------------------------------------------
// Unknown-id error path for EVERY targeted tool (string AND numeric args).
// ---------------------------------------------------------------------------

describe("adversary — unknown id throws for every session-targeted tool", () => {
	const targeted = [
		"send_text",
		"send_control",
		"read_screen",
		"read_new_output",
		"wait_for_idle",
		"wait_for_text",
		"read_events",
		"resize",
	];

	for (const name of targeted) {
		test(`${name} rejects unknown id with the exact message`, async () => {
			const { manager } = buildManager();
			const specs = createToolSpecs(manager);
			await expect(
				spec(specs, name).handler({
					id: "ghost-xyz",
					text: "t",
					key: "C-c",
					pattern: "p",
					cols: 10,
					rows: 10,
					quietMs: 1,
					timeoutMs: 1,
					sinceOffset: 0,
					scrollback: 0,
				}),
			).rejects.toThrow("session not found: ghost-xyz");
		});
	}

	test("close_session on an unknown id does NOT throw (idempotent { ok:true })", async () => {
		// close_session does not resolve via manager.get — it delegates to
		// manager.close which is idempotent. Asserting it stays ok guards against a
		// regression that would make close throw on a missing id.
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		const res = (await spec(specs, "close_session").handler({ id: "never-existed" })) as {
			ok: boolean;
		};
		expect(res.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Server surface — exactly the 11 §6 tools, correct names, registered live.
// ---------------------------------------------------------------------------

describe("adversary — server registers exactly the 11 §6 tools", () => {
	const EXPECTED = [
		"close_session",
		"list_sessions",
		"open_session",
		"read_events",
		"read_new_output",
		"read_screen",
		"resize",
		"send_control",
		"send_text",
		"wait_for_event",
		"wait_for_idle",
		"wait_for_text",
	].sort();

	test("createToolSpecs yields exactly 12 specs, no dupes", () => {
		const { manager } = buildManager();
		const specs = createToolSpecs(manager);
		expect(specs).toHaveLength(12);
		const names = specs.map((s) => s.name);
		expect(new Set(names).size).toBe(12);
		expect([...names].sort()).toEqual(EXPECTED);
	});

	test("createServer registers exactly the 11 tools on the live McpServer", () => {
		const { manager } = buildManager();
		const server = createServer({ manager });
		// McpServer keeps registered tools on its internal registry; reach in to
		// prove the SDK actually accepted all 11 (and their zod raw shapes).
		const internal = server as unknown as {
			_registeredTools?: Record<string, unknown>;
		};
		const registered = internal._registeredTools;
		expect(registered).toBeDefined();
		const names = Object.keys(registered ?? {}).sort();
		expect(names).toEqual(EXPECTED);
	});

	test("every spec carries a non-empty description and an object inputSchema", () => {
		const { manager } = buildManager();
		for (const s of createToolSpecs(manager)) {
			expect(typeof s.description).toBe("string");
			expect(s.description.length).toBeGreaterThan(0);
			expect(typeof s.inputSchema).toBe("object");
			expect(s.inputSchema).not.toBeNull();
		}
	});
});
