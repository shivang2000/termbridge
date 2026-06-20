import { describe, expect, it } from "bun:test";
import { rateLimitRecognizer } from "./rate-limit.js";

// A usage-limit screen with an explicit reset time.
const USAGE_LIMIT_FIXTURE = [
	"Claude usage limit reached.",
	"",
	"Your limit will reset at 3:00 PM.",
	"",
].join("\n");

// An ANSI-wrapped "rate limit" screen, to prove escapes are stripped first.
const RATE_LIMIT_ANSI_FIXTURE = [
	"\x1b[1mError\x1b[0m",
	"",
	"\x1b[31mYou have hit a rate limit. Please wait.\x1b[0m",
].join("\n");

// A limit screen with no reset information at all.
const NO_RESET_FIXTURE = ["Too many requests.", "Please slow down."].join("\n");

// Normal Claude output — must not match.
const PLAIN_FIXTURE = ["\x1b[32m●\x1b[0m done", "", "The build is green.", "$ "].join("\n");

describe("rateLimitRecognizer", () => {
	it("has kind 'rate_limited'", () => {
		expect(rateLimitRecognizer.kind).toBe("rate_limited");
	});

	it("detects a usage-limit screen and captures the reset time", () => {
		const out = rateLimitRecognizer.match(USAGE_LIMIT_FIXTURE, "");
		expect(out).not.toBeNull();
		expect(out?.data.message as string).toMatch(/usage limit reached/i);
		expect(out?.data.resetsAt as string).toMatch(/3:00 PM/);
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("detects an ANSI-wrapped rate-limit screen", () => {
		const out = rateLimitRecognizer.match(RATE_LIMIT_ANSI_FIXTURE, "");
		expect(out).not.toBeNull();
		expect(out?.data.message as string).toMatch(/rate limit/i);
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("omits resetsAt when there is no reset information", () => {
		const out = rateLimitRecognizer.match(NO_RESET_FIXTURE, "");
		expect(out).not.toBeNull();
		expect(out?.data.message as string).toMatch(/too many requests/i);
		expect("resetsAt" in (out?.data ?? {})).toBe(false);
	});

	it("returns null on plain Claude output", () => {
		expect(rateLimitRecognizer.match(PLAIN_FIXTURE, "")).toBeNull();
	});

	it("falls back to recentBytes when the screen is empty", () => {
		const out = rateLimitRecognizer.match("", USAGE_LIMIT_FIXTURE);
		expect(out?.data.message as string).toMatch(/usage limit reached/i);
	});

	// --- adversarial: false positives (the "limit" word in normal output) ---

	it("does NOT fire on 'rate limit' used in ordinary coding prose", () => {
		// Real fleet output: agents constantly write/read config and middleware
		// that mention rate limits. A false rate_limited event would make an
		// orchestrator needlessly back off a healthy session.
		for (const s of [
			"Set the rate limit to 100 req/s in nginx.conf",
			"We need rate limiting on this endpoint",
			"Let me check the rate limit config in settings.ts",
			"Added a rate-limiter to the API gateway.",
			"The token limit is 200k for this model.",
			"// TODO: document the rate limit behaviour",
		]) {
			expect(rateLimitRecognizer.match(s, "")).toBeNull();
		}
	});

	it("DOES fire on genuine rate-limit failure phrasings", () => {
		for (const s of [
			"You have hit a rate limit. Please wait.",
			"Your rate limit has been reached.",
			"Rate limit exceeded.",
			"You have been rate limited.",
		]) {
			expect(rateLimitRecognizer.match(s, "")).not.toBeNull();
		}
	});

	// --- adversarial: resetsAt must not over-capture ------------------------

	it("does NOT mistake an unrelated 'git reset' for a reset window", () => {
		const after = rateLimitRecognizer.match(
			"Claude usage limit reached.\nRun: git reset --hard HEAD.",
			"",
		);
		expect(after).not.toBeNull();
		expect("resetsAt" in (after?.data ?? {})).toBe(false);

		const before = rateLimitRecognizer.match(
			"I did git reset to fix things.\nClaude usage limit reached.",
			"",
		);
		expect(before).not.toBeNull();
		expect("resetsAt" in (before?.data ?? {})).toBe(false);
	});

	it("captures 'reset in <window>' as well as 'reset at <window>'", () => {
		const out = rateLimitRecognizer.match(
			"Claude usage limit reached. Your limit will reset in 2 hours.",
			"",
		);
		expect(out?.data.resetsAt as string).toMatch(/2 hours/);
	});

	// --- adversarial: control-char / ANSI noise -----------------------------

	it("strips heavy ANSI + OSC noise before matching", () => {
		// OSC title set (ST-terminated) + colour SGR wrapping the signal.
		const noisy =
			"\x1b]0;some title\x1b\\\x1b[2J\x1b[H\x1b[1;31mClaude usage limit reached.\x1b[0m";
		const out = rateLimitRecognizer.match(noisy, "");
		expect(out).not.toBeNull();
		expect(out?.data.message as string).toMatch(/usage limit reached/i);
	});

	it("handles a signal split across SGR escapes within a word", () => {
		// "usage limit reached" with an SGR injected mid-phrase, as a TUI may emit.
		const split = "Claude usage \x1b[1mlimit\x1b[0m reached.";
		const out = rateLimitRecognizer.match(split, "");
		expect(out).not.toBeNull();
		expect(out?.data.message as string).toMatch(/usage limit reached/i);
	});

	// --- adversarial: robustness / idempotency ------------------------------

	it("returns null on empty and whitespace-only input", () => {
		expect(rateLimitRecognizer.match("", "")).toBeNull();
		expect(rateLimitRecognizer.match("   \n\t  ", "  \n ")).toBeNull();
	});

	it("is idempotent — repeated calls give equal results (no regex lastIndex leak)", () => {
		const a = rateLimitRecognizer.match(USAGE_LIMIT_FIXTURE, "");
		const b = rateLimitRecognizer.match(USAGE_LIMIT_FIXTURE, "");
		expect(b).toEqual(a);
		// And a fresh non-match after a match must still be null (state-free).
		expect(rateLimitRecognizer.match(PLAIN_FIXTURE, "")).toBeNull();
		const c = rateLimitRecognizer.match(USAGE_LIMIT_FIXTURE, "");
		expect(c).toEqual(a);
	});

	it("never emits suggestedKeys (back-off is the orchestrator's job)", () => {
		const out = rateLimitRecognizer.match(USAGE_LIMIT_FIXTURE, "");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("prefers the screen over recentBytes when the screen has glyphs", () => {
		// A real limit screen present; recentBytes is stale noise — message comes
		// from the screen, not the bytes.
		const out = rateLimitRecognizer.match(USAGE_LIMIT_FIXTURE, "Too many requests.");
		expect(out?.data.message as string).toMatch(/usage limit reached/i);
	});
});
