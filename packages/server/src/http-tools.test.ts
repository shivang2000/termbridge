import { describe, expect, test } from "bun:test";
import { type Environment, PtyObserver, SessionManager } from "@termbridge/core";
import { createToolDispatch } from "./http-tools.js";

function fakeManager(): SessionManager {
	const env: Environment = {
		kind: "local",
		ensureSession: () => Promise.resolve(),
		tmux: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
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

describe("createToolDispatch", () => {
	test("exposes the §6 tool surface (11 core + wait_for_event)", () => {
		const d = createToolDispatch(fakeManager());
		expect(d.names).toContain("open_session");
		expect(d.names).toContain("send_text");
		expect(d.names).toContain("close_session");
		expect(d.names).toContain("wait_for_event");
		expect(d.names).toHaveLength(12);
	});

	test("open_session → send_text over the shared manager", async () => {
		const d = createToolDispatch(fakeManager());
		const opened = await d.call("open_session", { cwd: "/w" });
		expect(opened.ok).toBe(true);
		const id = opened.ok ? (opened.data as { id: string }).id : "";
		expect(id).toBe("id1");
		const sent = await d.call("send_text", { id, text: "hi" });
		expect(sent).toEqual({ ok: true, data: { ok: true } });
	});

	test("unknown tool → ok:false", async () => {
		const d = createToolDispatch(fakeManager());
		const res = await d.call("bogus", {});
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.error).toContain("unknown tool");
	});

	test("invalid args (zod) → ok:false", async () => {
		const d = createToolDispatch(fakeManager());
		const res = await d.call("send_text", {}); // missing id + text
		expect(res.ok).toBe(false);
	});

	test("unknown session id surfaces as ok:false", async () => {
		const d = createToolDispatch(fakeManager());
		const res = await d.call("read_screen", { id: "ghost" });
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.error).toContain("session not found");
	});
});
