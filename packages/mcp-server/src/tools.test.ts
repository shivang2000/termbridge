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
				"read_screen",
				"resize",
				"send_control",
				"send_text",
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
