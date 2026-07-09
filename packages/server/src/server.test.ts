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

describe("GET /api/sessions (P2.3 fleet inventory)", () => {
	test("401 without the token", async () => {
		const { app } = createTermbridgeServer({ manager: fakeManager(), token: "sek" });
		const res = await app.request("/api/sessions");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test("returns capacity + empty sessions when none registered", async () => {
		const mgr = fakeManager({
			capacity: () => ({ maxSessions: 4, count: 0 }),
			list: () => [],
		} as Partial<SessionManager>);
		const { app } = createTermbridgeServer({ manager: mgr, token: "sek" });
		const res = await app.request("/api/sessions?token=sek");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			maxSessions: 4,
			count: 0,
			sessions: [],
		});
	});

	test("enriches sessions with holder + status from lockState/lastActivityAt", async () => {
		const info: SessionInfo = {
			id: "s1",
			name: "tb-s1",
			env: "docker",
			state: "running",
		};
		const now = Date.now();
		const fakeSession = {
			lockState: () => "human-active" as const,
			lastActivityAt: () => now,
		};
		const mgr = fakeManager({
			capacity: () => ({ maxSessions: 3, count: 1 }),
			list: () => [info],
			get: ((id: string) => (id === "s1" ? fakeSession : undefined)) as SessionManager["get"],
		} as Partial<SessionManager>);
		const { app } = createTermbridgeServer({ manager: mgr, token: "sek" });
		const res = await app.request("/api/sessions", {
			headers: { Authorization: "Bearer sek" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			maxSessions: number;
			count: number;
			sessions: Array<{
				id: string;
				holder: string;
				status: string;
				env: string;
				lastActivityAt: number;
			}>;
		};
		expect(body.ok).toBe(true);
		expect(body.maxSessions).toBe(3);
		expect(body.count).toBe(1);
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0]?.id).toBe("s1");
		expect(body.sessions[0]?.env).toBe("docker");
		expect(body.sessions[0]?.holder).toBe("human");
		expect(body.sessions[0]?.status).toBe("human-takeover");
		expect(body.sessions[0]?.lastActivityAt).toBe(now);
	});

	test("maps agent + recent activity to driving, stale to idle", async () => {
		const info: SessionInfo = { id: "s2", name: "n", env: "local", state: "running" };
		const recent = {
			lockState: () => "agent" as const,
			lastActivityAt: () => Date.now(),
		};
		const mgr = fakeManager({
			capacity: () => ({ maxSessions: 4, count: 1 }),
			list: () => [info],
			get: (() => recent) as unknown as SessionManager["get"],
		} as Partial<SessionManager>);
		const { app } = createTermbridgeServer({ manager: mgr, token: "sek" });
		const body = (await (await app.request("/api/sessions?token=sek")).json()) as {
			sessions: Array<{ status: string; holder: string }>;
		};
		expect(body.sessions[0]?.holder).toBe("agent");
		expect(body.sessions[0]?.status).toBe("driving");
	});
});

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
