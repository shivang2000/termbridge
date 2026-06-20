// Adversarial probes of the HTTP tool dispatch. Goal: confirm that EVERY failure
// mode — a handler that throws mid-call, zod-rejected args, unknown tool, unknown
// session, and odd request bodies — collapses to a structured { ok:false } and
// never escapes as an unhandled rejection (which would 500 the unified server).

import { describe, expect, test } from "bun:test";
import { type Environment, PtyObserver, SessionManager } from "@termbridge/core";
import { createToolDispatch } from "./http-tools.js";

/**
 * Manager whose env's tmux throws ONLY for argv whose first token is in
 * `throwOn` — so `open_session` (ensureSession + `pipe-pane`) still succeeds and
 * registers a session, but a LATER session-targeted tool call explodes. Throwing
 * during `pipe-pane`/`ensureSession` would just fail `open()` and register
 * nothing, which is not the scenario we want to probe.
 */
function fakeManager(opts: { throwOn?: string[]; throwValue?: unknown } = {}): SessionManager {
	const throwOn = new Set(opts.throwOn ?? []);
	const env: Environment = {
		kind: "local",
		ensureSession: () => Promise.resolve(),
		tmux: (args: string[]) => {
			if (throwOn.has(args[0] ?? "")) {
				return Promise.reject(opts.throwValue ?? new Error("tmux exploded"));
			}
			return Promise.resolve({ stdout: "", stderr: "", code: 0 });
		},
		destroySession: () => Promise.resolve(),
		listSessions: () => Promise.resolve([]),
	};
	let n = 0;
	return new SessionManager({
		envFactory: () => env,
		observerFactory: () => new PtyObserver({ clock: () => 0 }),
		idGen: () => `id${++n}`,
	});
}

describe("http-tools — error passthrough (adversarial)", () => {
	test("a tool whose handler THROWS mid-call surfaces as { ok:false } with the message", async () => {
		// resize-window throws, but open's ensureSession + pipe-pane succeed.
		const d = createToolDispatch(fakeManager({ throwOn: ["resize-window"] }));
		const opened = await d.call("open_session", {});
		const id = opened.ok ? (opened.data as { id: string }).id : "";
		expect(id).toBe("id1");
		// resize → env.tmux rejects → handler throws → dispatch catches → ok:false.
		const res = await d.call("resize", { id, cols: 100, rows: 40 });
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.error).toContain("tmux exploded");
	});

	test("a thrown non-Error value is stringified, still { ok:false }", async () => {
		// capture-pane throws a raw string; open still succeeds.
		const d = createToolDispatch(
			fakeManager({ throwOn: ["capture-pane"], throwValue: "raw string failure" }),
		);
		const opened = await d.call("open_session", {});
		const id = opened.ok ? (opened.data as { id: string }).id : "";
		expect(id).toBe("id1");
		const res = await d.call("read_screen", { id });
		expect(res.ok).toBe(false);
		expect(res.ok === false && typeof res.error).toBe("string");
		expect(res.ok === false && res.error).toContain("raw string failure");
	});
});

describe("http-tools — zod rejection (adversarial)", () => {
	test("wrong-typed args are rejected before the handler runs", async () => {
		const d = createToolDispatch(fakeManager());
		// resize wants positive ints; feed it junk.
		const a = await d.call("resize", { id: "x", cols: -5, rows: 0 });
		const b = await d.call("resize", { id: "x", cols: 1.5, rows: 10 });
		const c = await d.call("send_text", { id: 123, text: "hi" }); // id must be string
		const e = await d.call("send_control", { id: "x" }); // missing key
		expect(a.ok).toBe(false);
		expect(b.ok).toBe(false);
		expect(c.ok).toBe(false);
		expect(e.ok).toBe(false);
	});

	test("extra/unknown keys are tolerated (zod object is non-strict) and do not break the call", async () => {
		const d = createToolDispatch(fakeManager());
		const res = await d.call("list_sessions", { bogusExtra: true, another: 99 });
		expect(res.ok).toBe(true);
	});

	test("a null/undefined/array body for a no-arg tool defaults to {} and succeeds", async () => {
		const d = createToolDispatch(fakeManager());
		expect((await d.call("list_sessions", null)).ok).toBe(true);
		expect((await d.call("list_sessions", undefined)).ok).toBe(true);
	});

	test("a body that is a primitive for a tool needing fields → zod rejects, ok:false", async () => {
		const d = createToolDispatch(fakeManager());
		const res = await d.call("send_text", "not an object");
		expect(res.ok).toBe(false);
	});

	test("unknown tool and unknown session both stay ok:false (no throw)", async () => {
		const d = createToolDispatch(fakeManager());
		expect((await d.call("does_not_exist", {})).ok).toBe(false);
		const ghost = await d.call("read_screen", { id: "ghost" });
		expect(ghost.ok).toBe(false);
		expect(ghost.ok === false && ghost.error).toContain("session not found");
	});
});
