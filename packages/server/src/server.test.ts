import { describe, expect, test } from "bun:test";
import type { SessionInfo, SessionManager } from "@termbridge/core";
import { createTermbridgeServer } from "./server.js";

/** A stub SessionManager exposing just what the /login route touches. */
function fakeManager(over: Partial<SessionManager> = {}): SessionManager {
	return {
		open: async () => ({ id: "sess1" }),
		list: () => [],
		get: () => undefined,
		...over,
	} as unknown as SessionManager;
}

describe("/login route", () => {
	test("401 without the token", async () => {
		const { app } = createTermbridgeServer({ manager: fakeManager(), token: "sek" });
		const res = await app.request("/login");
		expect(res.status).toBe(401);
	});

	test("opens a 'claude' session and 302-redirects to the watch UI with the token", async () => {
		let openedCmd: string | undefined;
		const mgr = fakeManager({
			open: (async (o?: { cmd?: string }) => {
				openedCmd = o?.cmd;
				return { id: "sess1" };
			}) as unknown as SessionManager["open"],
		});
		const { app } = createTermbridgeServer({ manager: mgr, token: "sek" });
		const res = await app.request("/login?token=sek");
		expect(res.status).toBe(302);
		const loc = res.headers.get("location") ?? "";
		expect(loc).toContain("session=sess1");
		expect(loc).toContain("token=sek");
		expect(openedCmd).toBe("claude");
	});

	test("reuses an existing session when open() fails (cap reached)", async () => {
		const existing: SessionInfo = { id: "existing1", name: "n", env: "local", state: "running" };
		const mgr = fakeManager({
			open: (async () => {
				throw new Error("cap");
			}) as unknown as SessionManager["open"],
			list: (() => [existing]) as unknown as SessionManager["list"],
		});
		const { app } = createTermbridgeServer({ manager: mgr, token: "sek" });
		const res = await app.request("/login?token=sek");
		expect(res.status).toBe(302);
		expect(res.headers.get("location") ?? "").toContain("session=existing1");
	});
});
