import { describe, expect, it } from "bun:test";
import { needsUserInputMarkerRecognizer, selfCheckMarkerRecognizer } from "./tb-marker.js";

describe("needsUserInputMarkerRecognizer", () => {
	it("has kind 'needs_user_input' so wait_for_event.kinds can filter on it", () => {
		expect(needsUserInputMarkerRecognizer.kind).toBe("needs_user_input");
	});

	it("detects TB_ASK and surfaces question text", () => {
		const screen = "Some preamble\n● TB_ASK: Which auth provider should I use?\n";
		const out = needsUserInputMarkerRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.question).toBe("Which auth provider should I use?");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("anchors TB_ASK to the start of the line (echo-safe)", () => {
		// A line in the body that mentions TB_ASK in prose is NOT a marker.
		const screen = "When you finish, print: TB_ASK: PASS — the echoed prompt must not match.";
		const out = needsUserInputMarkerRecognizer.match(screen, "");
		expect(out).toBeNull();
	});

	it("tolerates a leading TUI bullet and indentation", () => {
		const screen = "⏺ TB_ASK:  What's the project name?\n";
		const out = needsUserInputMarkerRecognizer.match(screen, "");
		expect(out?.data.question).toBe("What's the project name?");
	});

	it("falls back to recentBytes when screen is blank", () => {
		const out = needsUserInputMarkerRecognizer.match("   \n", "TB_ASK: pick one\n");
		expect(out?.data.question).toBe("pick one");
	});

	it("returns null on screens with no marker", () => {
		expect(needsUserInputMarkerRecognizer.match("Just normal output here.\n", "")).toBeNull();
	});
});

describe("selfCheckMarkerRecognizer", () => {
	it("has kind 'self_check_request'", () => {
		expect(selfCheckMarkerRecognizer.kind).toBe("self_check_request");
	});

	it("detects TB_SELF_CHECK and surfaces the command", () => {
		const out = selfCheckMarkerRecognizer.match("TB_SELF_CHECK: npm test\n", "");
		expect(out?.data.command).toBe("npm test");
	});

	it("returns null when no marker is present", () => {
		expect(selfCheckMarkerRecognizer.match("Just normal output here.\n", "")).toBeNull();
	});
});
