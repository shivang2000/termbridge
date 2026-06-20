import { describe, expect, it } from "bun:test";
import { claudePermissionRecognizer as r } from "./claude-permission.js";

// Adversarial suite for the claude-permission recognizer. These probe the
// edges a teammate's happy-path fixtures missed: priority ordering, blank
// capture-pane screens, CRLF, ANSI-inside-labels, casing, garbage input.

describe("claude-permission (adversarial)", () => {
	it("prioritises a tool question over a co-present bypass banner", () => {
		const screen = [
			"WARNING: Bypass Permissions mode",
			"Do you want to enable Bypass Permissions mode?",
			"  1. No, exit",
			"  2. Yes, I accept",
		].join("\n");
		const out = r.match(screen, "");
		// Spec: TOOL is highest priority, so a numbered "Do you want to…?" wins.
		expect(out?.data.kind).toBe("tool");
		expect(out?.suggestedKeys).toEqual(["1"]);
	});

	it("tool question wins even when 'bypass permissions' appears as prose", () => {
		const screen = ["Note: bypass permissions is off.", "Do you want to proceed?", "❯ 1. Yes"].join(
			"\n",
		);
		expect(r.match(screen, "")?.data.kind).toBe("tool");
	});

	it("uses the FIRST 'Do you want to…?' line as the question", () => {
		const screen = [
			"Do you want to delete everything?",
			"narrative",
			"Do you want to proceed?",
			"❯ 1. Yes",
			"  2. No",
		].join("\n");
		expect(r.match(screen, "")?.data.question).toBe("Do you want to delete everything?");
	});

	it("falls back to recentBytes when the screen is blank-padded whitespace", () => {
		// tmux capture-pane commonly returns whitespace-padded blank lines while
		// the real prompt streamed through the byte tail.
		const blankScreen = "\n   \n      \n   \n";
		const recent = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
		const out = r.match(blankScreen, recent);
		expect(out).not.toBeNull();
		expect(out?.data.kind).toBe("tool");
		expect(out?.suggestedKeys).toEqual(["1"]);
	});

	it("returns null when both screen and recentBytes are blank/whitespace", () => {
		expect(r.match("   \n  \n", "   ")).toBeNull();
	});

	it("returns null on an ANSI-only screen", () => {
		expect(r.match("\x1b[1m\x1b[0m\x1b[33m", "")).toBeNull();
	});

	it("handles CRLF line endings without leaking carriage returns", () => {
		const screen = "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n";
		const out = r.match(screen, "");
		expect(out?.data.question).toBe("Do you want to proceed?");
		expect(out?.data.options).toEqual(["Yes", "No"]);
		// no stray \r in any captured field
		expect(JSON.stringify(out)).not.toContain("\\r");
	});

	it("strips ANSI sequences embedded inside option labels", () => {
		const screen = [
			"Do you want to proceed?",
			"❯ 1. \x1b[1mYes\x1b[0m, keep going",
			"  2. No",
		].join("\n");
		expect(r.match(screen, "")?.data.options).toEqual(["Yes, keep going", "No"]);
	});

	it("does not confuse a number inside an option label for a new option", () => {
		const screen = ["Do you want to proceed?", "❯ 1. Yes", "  2. Run step 3. now"].join("\n");
		expect(r.match(screen, "")?.data.options).toEqual(["Yes", "Run step 3. now"]);
	});

	it("requires a question mark — narration starting 'Do you want to' is not a prompt", () => {
		expect(r.match("Do you want to proceed", "")).toBeNull();
	});

	it("matches a lowercased question (casing-insensitive)", () => {
		expect(r.match("do you want to proceed?\n❯ 1. Yes", "")?.data.kind).toBe("tool");
	});

	it("bypass: picks the accept option's number when it is not 2", () => {
		const screen = ["Bypass Permissions mode", "  1. No", "  3. Yes, I accept the risk"].join("\n");
		const out = r.match(screen, "");
		expect(out?.data.kind).toBe("bypass");
		expect(out?.suggestedKeys).toEqual(["3"]);
	});

	it("bypass: defaults suggestedKeys to ['2'] when no accept option is parseable", () => {
		const out = r.match("You are now in bypass permissions mode.", "");
		expect(out?.data.kind).toBe("bypass");
		expect(out?.suggestedKeys).toEqual(["2"]);
	});

	it("bypass: matches the 'I accept' option without the 'Yes,' prefix", () => {
		const screen = ["Bypass Permissions", "  1. Cancel", "  2. I accept"].join("\n");
		expect(r.match(screen, "")?.suggestedKeys).toEqual(["2"]);
	});

	it("paste: matches 'paste the code' phrasing and casing variants", () => {
		expect(r.match("PASTE THE CODE BELOW", "")?.data.kind).toBe("paste");
		expect(r.match("Paste code here if prompted >", "")?.data.kind).toBe("paste");
	});

	it("paste: never suggests keys", () => {
		expect(r.match("paste the code", "")?.suggestedKeys).toEqual([]);
	});

	it("tolerates a giant noisy scrollback without misfiring", () => {
		const noise = `${"lorem ipsum dolor sit amet\n".repeat(500)}$ `;
		expect(r.match(noise, "")).toBeNull();
	});

	it("returns null on empty inputs", () => {
		expect(r.match("", "")).toBeNull();
	});

	it("is stable across repeated calls (no shared regex lastIndex state)", () => {
		const screen = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
		const first = r.match(screen, "");
		const second = r.match(screen, "");
		expect(second).toEqual(first);
		// run a few more times to flush any global-regex lastIndex bug
		expect(r.match(screen, "")).toEqual(first);
		expect(r.match(screen, "")).toEqual(first);
	});

	it("does not mutate the suggestedKeys array between calls", () => {
		const a = r.match("Do you want to proceed?\n❯ 1. Yes", "");
		a?.suggestedKeys.push("x"); // mutate the returned array
		const b = r.match("Do you want to proceed?\n❯ 1. Yes", "");
		expect(b?.suggestedKeys).toEqual(["1"]); // must be a fresh array
	});
});
