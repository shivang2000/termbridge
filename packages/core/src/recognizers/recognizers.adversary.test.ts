import { describe, expect, it } from "bun:test";
import type { RecognizedEvent, Recognizer } from "../types.js";
import { oauthUrlRecognizer } from "./oauth-url.js";
import { RecognizerPipeline } from "./pipeline.js";
import { detectDeviceCode, detectOAuthPrompt } from "./url-detector.js";

// ===========================================================================
// detectOAuthPrompt — adversarial
// ===========================================================================
describe("detectOAuthPrompt [adversary]", () => {
	it("returns null on the empty string (no hint, no url)", () => {
		expect(detectOAuthPrompt("")).toBeNull();
	});

	it("returns null on pure ANSI/control noise", () => {
		expect(detectOAuthPrompt("\x1b[2J\x1b[H\x1b[1;31m\x07\x1b]0;title\x07\x1b[0m")).toBeNull();
	});

	it("returns null when a hint phrase is present but there is no https url", () => {
		// http:// (insecure) is intentionally NOT matched — only https.
		expect(detectOAuthPrompt("Open the following URL: http://insecure.example.com")).toBeNull();
	});

	it("does not treat the literal 'https://' alone as a url (length guard)", () => {
		// Hint present, bare scheme with nothing after it → must be rejected.
		expect(detectOAuthPrompt("Visit this URL: https://")).toBeNull();
	});

	it("does not crash and finds the url even if the hint appears AFTER the url", () => {
		// HINTS test the whole cleaned buffer, indexOf finds the first https.
		const out = detectOAuthPrompt(
			"https://claude.ai/login/z\nOpen the following URL above to sign in",
		);
		expect(out?.url).toBe("https://claude.ai/login/z");
	});

	it("keeps percent-encoded and query/fragment chars in the url", () => {
		const out = detectOAuthPrompt("Open the following URL: https://x.com/cb?a=1&b=2%3Dz#frag");
		expect(out?.url).toBe("https://x.com/cb?a=1&b=2%3Dz#frag");
	});

	it("terminates the url at the first space (urls have no whitespace)", () => {
		const out = detectOAuthPrompt("Open the following URL: https://x.com/ok then do something");
		expect(out?.url).toBe("https://x.com/ok");
	});

	it("strips a run of trailing sentence punctuation, not just one char", () => {
		const out = detectOAuthPrompt("Visit this URL: https://claude.ai/login?!.");
		expect(out?.url).toBe("https://claude.ai/login");
	});

	it("does NOT strip a meaningful trailing query char like '=' ", () => {
		// '=' is not sentence punctuation, must survive (it can be part of base64 qs).
		const out = detectOAuthPrompt("Visit this URL: https://x.com/cb?token=");
		expect(out?.url).toBe("https://x.com/cb?token=");
	});

	it("handles a tab between hint and url (tab terminates url scan but hint still fires)", () => {
		const out = detectOAuthPrompt("Visit this URL:\thttps://x.com/ok\tmore");
		expect(out?.url).toBe("https://x.com/ok");
	});

	it("reassembles nothing across a wrapped url — returns only the first physical line", () => {
		// Documented behavior: stop at CR/LF. A wrapped url yields a truncated url,
		// never a glued-together one. Assert we do NOT glue the second line on.
		const wrapped = "Open the following URL: https://x.com/aaaa\r\nbbbb/cccc";
		expect(detectOAuthPrompt(wrapped)?.url).toBe("https://x.com/aaaa");
	});

	it("survives a very long buffer (100k chars) with the url at the end", () => {
		const noise = "lorem ipsum ".repeat(8000); // ~96k chars, no https
		const buf = `${noise}\nOpen the following URL: https://x.com/deep`;
		const out = detectOAuthPrompt(buf);
		expect(out?.url).toBe("https://x.com/deep");
	});

	it("survives a pathological very long single 'url' token without hanging", () => {
		const longTail = "a".repeat(50000);
		const buf = `Visit this URL: https://x.com/${longTail}`;
		const out = detectOAuthPrompt(buf);
		expect(out?.url).toBe(`https://x.com/${longTail}`);
	});

	it("a raw unicode char terminates the url scan (URL_CHAR is ASCII-only)", () => {
		// A smart-quote or emoji right after the url ends the token cleanly.
		const out = detectOAuthPrompt("Visit this URL: https://x.com/ok—dash");
		expect(out?.url).toBe("https://x.com/ok");
	});

	it("matches the sentry-cli 'URL:' line-anchored hint", () => {
		const out = detectOAuthPrompt("URL:  https://sentry.io/oauth/device/?user_code=ABCD");
		expect(out?.url).toBe("https://sentry.io/oauth/device/?user_code=ABCD");
	});

	it("does not strip a trailing ')' even though prose may have wrapped it", () => {
		// ')' is a valid URL_CHAR and is NOT in the trailing-punct strip set,
		// so a markdown-style (url) keeps the paren. Document the sharp edge.
		const out = detectOAuthPrompt("Open the following URL (https://x.com/ok)");
		expect(out?.url).toBe("https://x.com/ok)");
	});
});

// ===========================================================================
// detectDeviceCode — adversarial
// ===========================================================================
describe("detectDeviceCode [adversary]", () => {
	it("returns null on empty input", () => {
		expect(detectDeviceCode("")).toBeNull();
	});

	it("returns null when no code-shaped token is present", () => {
		expect(detectDeviceCode("just regular output with no code")).toBeNull();
	});

	it("extracts and uppercases a one-time code regardless of input case", () => {
		expect(detectDeviceCode("First copy your one-time code: wgql-wqpc")).toBe("WGQL-WQPC");
	});

	it("matches the sentry 'Code:' line-anchored form", () => {
		expect(detectDeviceCode("  Code:  CFWD-TBXH  ")).toBe("CFWD-TBXH");
	});

	it("matches user_code= in a url query", () => {
		expect(detectDeviceCode("https://sentry.io/oauth/device/?user_code=WGQL-WQPC")).toBe(
			"WGQL-WQPC",
		);
	});

	it("strips ANSI before matching the code", () => {
		expect(
			detectDeviceCode("\x1b[1mFirst copy your one-time code:\x1b[0m \x1b[32mABCD-1234\x1b[0m"),
		).toBe("ABCD-1234");
	});

	it("does not false-positive on the word 'code' followed by prose", () => {
		// 'Code:' line form requires the whole line to be just the code (anchored $).
		expect(detectDeviceCode("Code: please read the documentation")).toBeNull();
	});
});

// ===========================================================================
// oauthUrlRecognizer — adversarial
// ===========================================================================
describe("oauthUrlRecognizer [adversary]", () => {
	it("returns null on empty screen AND empty recentBytes", () => {
		expect(oauthUrlRecognizer.match("", "")).toBeNull();
	});

	it("never includes a 'code' key when no device code is present", () => {
		const out = oauthUrlRecognizer.match(
			"Browser didn't open? sign in at https://claude.ai/login/x",
			"",
		);
		expect(out).not.toBeNull();
		expect("code" in (out?.data ?? {})).toBe(false);
	});

	it("prefers the screen url over the recentBytes url when both match", () => {
		const out = oauthUrlRecognizer.match(
			"Open the following URL: https://screen.example/login",
			"Open the following URL: https://recent.example/login",
		);
		expect(out?.data.url).toBe("https://screen.example/login");
	});

	it("can take the url from the screen but the code from recentBytes", () => {
		// screen has the url (no code visible), recent buffer still holds the code.
		const out = oauthUrlRecognizer.match(
			"Open the following URL: https://github.com/login/device",
			"First copy your one-time code: ABCD-1234",
		);
		expect(out?.data.url).toBe("https://github.com/login/device");
		expect(out?.data.code).toBe("ABCD-1234");
	});

	it("returns an empty suggestedKeys array (human acts out-of-band)", () => {
		const out = oauthUrlRecognizer.match("Open the following URL: https://x.com/ok", "");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("emits data that round-trips through JSON (pipeline dedup relies on this)", () => {
		const out = oauthUrlRecognizer.match(
			"Open the following URL: https://x.com/ok\nFirst copy your one-time code: ZZ99-AA11",
			"",
		);
		expect(() => JSON.stringify(out?.data)).not.toThrow();
		expect(JSON.parse(JSON.stringify(out?.data))).toEqual({
			url: "https://x.com/ok",
			code: "ZZ99-AA11",
		});
	});
});

// ===========================================================================
// RecognizerPipeline — adversarial
// ===========================================================================
describe("RecognizerPipeline [adversary]", () => {
	it("treats a {} payload as a real match (truthy object), then dedupes", () => {
		const p = new RecognizerPipeline();
		const emptyObj: Recognizer = {
			kind: "empty",
			match(): Omit<RecognizedEvent, "kind"> | null {
				return { data: {}, suggestedKeys: [] };
			},
		};
		p.register(emptyObj);
		expect(p.process("x", "")).toEqual([{ kind: "empty", data: {}, suggestedKeys: [] }]);
		expect(p.process("x", "")).toEqual([]);
	});

	it("treats null payload as 'no match' and clears dedup state", () => {
		const p = new RecognizerPipeline();
		let on = true;
		const toggling: Recognizer = {
			kind: "t",
			match(): Omit<RecognizedEvent, "kind"> | null {
				return on ? { data: { v: 1 }, suggestedKeys: [] } : null;
			},
		};
		p.register(toggling);
		expect(p.process("", "")).toHaveLength(1); // emit
		expect(p.process("", "")).toEqual([]); // dedupe
		on = false;
		expect(p.process("", "")).toEqual([]); // no match, state cleared
		on = true;
		expect(p.process("", "")).toHaveLength(1); // fresh emit after gap
	});

	it("dedup is sensitive to JSON key ORDER (documents a sharp edge)", () => {
		// Same logical data but different key insertion order serializes differently,
		// so the pipeline re-emits. This is a real limitation worth pinning down.
		const p = new RecognizerPipeline();
		let order = 0;
		const r: Recognizer = {
			kind: "order",
			match(): Omit<RecognizedEvent, "kind"> | null {
				order += 1;
				const data = order === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 };
				return { data, suggestedKeys: [] };
			},
		};
		p.register(r);
		expect(p.process("", "")).toHaveLength(1);
		// Reordered keys → different JSON signature → spurious re-emit.
		expect(p.process("", "")).toHaveLength(1);
	});

	it("handles a large number of registered recognizers", () => {
		const p = new RecognizerPipeline();
		for (let i = 0; i < 500; i++) {
			p.register(stub(`k${i}`, "GO", { i }));
		}
		const events = p.process("GO", "");
		expect(events).toHaveLength(500);
		// second identical poll → all deduped
		expect(p.process("GO", "")).toEqual([]);
	});

	it("two recognizers sharing the same kind both emit when their data differs", () => {
		// Pathological: duplicate kinds. Both write to the same lastEmitted entry.
		// Verify it does not crash and last-writer-wins semantics hold.
		const p = new RecognizerPipeline();
		p.register(stub("dup", "A", { from: "first" }));
		p.register(stub("dup", "A", { from: "second" }));
		const events = p.process("A", "");
		// Both match; first sets sig, second has different sig → both emit.
		expect(events.map((e) => e.data)).toEqual([{ from: "first" }, { from: "second" }]);
	});

	it("preserves data and suggestedKeys references from the recognizer payload", () => {
		const p = new RecognizerPipeline();
		const keys = ["y", "Enter"];
		const data = { q: "ok?" };
		const r: Recognizer = {
			kind: "ref",
			match() {
				return { data, suggestedKeys: keys };
			},
		};
		p.register(r);
		const [event] = p.process("x", "");
		expect(event?.data).toBe(data);
		expect(event?.suggestedKeys).toBe(keys);
	});
});

function stub(kind: string, needle: string, data: Record<string, unknown> = {}): Recognizer {
	return {
		kind,
		match(screen: string): Omit<RecognizedEvent, "kind"> | null {
			return screen.includes(needle) ? { data, suggestedKeys: [] } : null;
		},
	};
}
