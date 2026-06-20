import { describe, expect, it } from "bun:test";
import { oauthUrlRecognizer } from "./oauth-url.js";

describe("oauthUrlRecognizer", () => {
	it("has kind 'oauth-url'", () => {
		expect(oauthUrlRecognizer.kind).toBe("oauth-url");
	});

	it("matches a realistic gh login buffer (url + device code)", () => {
		const screen =
			"! First copy your one-time code: ABCD-1234\n" +
			"Open the following URL in your browser: https://github.com/login/device\n" +
			"Press Enter to open github.com in your browser...";
		const out = oauthUrlRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.url).toBe("https://github.com/login/device");
		expect(out?.data.code).toBe("ABCD-1234");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("matches a claude login buffer with just a url (no code)", () => {
		const screen =
			"Browser didn't open? Use the URL below to sign in to Claude\n\n" +
			"https://claude.ai/login/x\n";
		const out = oauthUrlRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.url).toBe("https://claude.ai/login/x");
		expect(out?.data.code).toBeUndefined();
		expect("code" in (out?.data ?? {})).toBe(false);
	});

	it("returns null on a buffer with no oauth prompt", () => {
		expect(oauthUrlRecognizer.match("just some regular output\n$ ", "")).toBeNull();
	});

	it("falls back to recentBytes when the screen has no url", () => {
		const recent = "Open the following URL in your browser: https://github.com/login/device\n";
		const out = oauthUrlRecognizer.match("$ ", recent);
		expect(out?.data.url).toBe("https://github.com/login/device");
	});

	it("uppercases the device code", () => {
		const screen =
			"Open the following URL: https://github.com/login/device\n" +
			"First copy your one-time code: abcd-1234\n";
		const out = oauthUrlRecognizer.match(screen, "");
		expect(out?.data.code).toBe("ABCD-1234");
	});
});
