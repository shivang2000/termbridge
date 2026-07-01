import { describe, expect, test } from "bun:test";
import { createRemoteCaller, createRemoteToolSpecs } from "./remote.js";

function stubFetch(
	handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
) {
	return (async (url: string, init: RequestInit) => {
		const { status = 200, body } = handler(url, init);
		return { status, json: async () => body } as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("createRemoteCaller", () => {
	test("POSTs to /api/tool/:name with the token in the Authorization header (not the URL)", async () => {
		let seen: { url: string; headers: Record<string, string>; body: unknown } | undefined;
		const caller = createRemoteCaller({
			serverUrl: "http://h:1",
			token: "T",
			fetchImpl: stubFetch((url, init) => {
				seen = {
					url,
					headers: init.headers as Record<string, string>,
					body: JSON.parse(init.body as string),
				};
				return { body: { ok: true, data: { id: "s1" } } };
			}),
		});
		const out = await caller("open_session", { env: "local" });
		expect(out).toEqual({ id: "s1" });
		// Token MUST NOT appear in the URL (it would leak into access logs).
		expect(seen?.url).toBe("http://h:1/api/tool/open_session");
		expect(seen?.url).not.toContain("token=");
		// Token MUST be carried in the Authorization: Bearer header.
		expect(seen?.headers.authorization).toBe("Bearer T");
		expect(seen?.body).toEqual({ env: "local" });
	});

	test("throws on outer !ok (MCP error parity)", async () => {
		const caller = createRemoteCaller({
			serverUrl: "http://h:1",
			token: "T",
			fetchImpl: stubFetch(() => ({
				status: 400,
				body: { ok: false, error: "session not found: x" },
			})),
		});
		await expect(caller("read_screen", { id: "x" })).rejects.toThrow("session not found: x");
	});

	test("keeps inner human_driving as DATA (outer ok)", async () => {
		const caller = createRemoteCaller({
			serverUrl: "http://h:1",
			token: "T",
			fetchImpl: stubFetch(() => ({
				body: { ok: true, data: { ok: false, error: "human_driving" } },
			})),
		});
		expect(await caller("send_text", { id: "s1", text: "x" })).toEqual({
			ok: false,
			error: "human_driving",
		});
	});
});

describe("createRemoteToolSpecs", () => {
	test("mirrors the tool names and delegates each handler to the caller", async () => {
		const calls: Array<[string, unknown]> = [];
		const caller = async (name: string, args: unknown) => {
			calls.push([name, args]);
			return { echoed: name };
		};
		const specs = createRemoteToolSpecs(caller);
		expect(specs.map((s) => s.name)).toEqual(
			expect.arrayContaining(["open_session", "send_text", "list_sessions"]),
		);
		const open = specs.find((s) => s.name === "open_session");
		if (!open) throw new Error("open_session spec not found");
		expect(await open.handler({ env: "local" })).toEqual({ echoed: "open_session" });
		expect(calls).toEqual([["open_session", { env: "local" }]]);
	});
});
