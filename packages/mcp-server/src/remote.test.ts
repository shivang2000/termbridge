import { describe, expect, test } from "bun:test";
import { createRemoteCaller } from "./remote.js";

function stubFetch(
	handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
) {
	return (async (url: string, init: RequestInit) => {
		const { status = 200, body } = handler(url, init);
		return { status, json: async () => body } as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("createRemoteCaller", () => {
	test("POSTs to /api/tool/:name?token= and returns inner data on outer ok", async () => {
		let seen: { url: string; body: unknown } | undefined;
		const caller = createRemoteCaller({
			serverUrl: "http://h:1",
			token: "T",
			fetchImpl: stubFetch((url, init) => {
				seen = { url, body: JSON.parse(init.body as string) };
				return { body: { ok: true, data: { id: "s1" } } };
			}),
		});
		const out = await caller("open_session", { env: "local" });
		expect(out).toEqual({ id: "s1" });
		expect(seen?.url).toBe("http://h:1/api/tool/open_session?token=T");
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
