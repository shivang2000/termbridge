import { describe, expect, it } from "bun:test";
import { tbMarkerRecognizer } from "./tb-marker.js";

describe("tbMarkerRecognizer", () => {
	it("has kind 'tb-marker'", () => {
		expect(tbMarkerRecognizer.kind).toBe("tb-marker");
	});

	// --- needs_user_input ---------------------------------------------------

	it("detects TB_ASK and surfaces question text", () => {
		const screen = "Some preamble\n● TB_ASK: Which auth provider should I use?\n";
		const out = tbMarkerRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.kind).toBe("needs_user_input");
		expect(out?.data.question).toBe("Which auth provider should I use?");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("anchors TB_ASK to the start of the line (echo-safe)", () => {
		// A line in the body that mentions TB_ASK in prose is NOT a marker.
		const screen = "When you finish, print: TB_ASK: PASS — the echoed prompt must not match.";
		const out = tbMarkerRecognizer.match(screen, "");
		expect(out).toBeNull();
	});

	it("tolerates a leading TUI bullet and indentation", () => {
		const screen = "⏺ TB_ASK:  What's the project name?\n";
		const out = tbMarkerRecognizer.match(screen, "");
		expect(out?.data.kind).toBe("needs_user_input");
		expect(out?.data.question).toBe("What's the project name?");
	});

	it("falls back to recentBytes when screen is blank", () => {
		const out = tbMarkerRecognizer.match("   \n", "TB_ASK: pick one\n");
		expect(out?.data.question).toBe("pick one");
	});

	// --- self_check ---------------------------------------------------------

	it("detects TB_SELF_CHECK and surfaces the command", () => {
		const screen = "TB_SELF_CHECK: npm test\n";
		const out = tbMarkerRecognizer.match(screen, "");
		expect(out?.data.kind).toBe("self_check");
		expect(out?.data.command).toBe("npm test");
	});

	// --- quiet --------------------------------------------------------------

	it("returns null on screens with no marker", () => {
		expect(tbMarkerRecognizer.match("Just normal output here.\n", "")).toBeNull();
	});
});
