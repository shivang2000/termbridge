import { describe, expect, it } from "bun:test";
import { claudePermissionRecognizer } from "./claude-permission.js";

// Realistic Claude Code 2.1.x tool-permission prompt, with ANSI colour codes
// sprinkled in to prove the recognizer strips them before matching.
const TOOL_FIXTURE = [
	"\x1b[1mEdit file\x1b[0m",
	"  src/index.ts",
	"",
	"\x1b[33mDo you want to make this edit?\x1b[0m",
	"\x1b[36m❯ 1. Yes\x1b[0m",
	"  2. Yes, and don't ask again for edits in this session",
	"  3. No, and tell Claude what to do differently (esc)",
	"",
].join("\n");

const PROCEED_FIXTURE = [
	"\x1b[1mBash command\x1b[0m",
	"  npm install",
	"",
	"Do you want to proceed?",
	"❯ 1. Yes",
	"  2. Yes, and don't ask again for npm commands in /home/user/project",
	"  3. No, and tell Claude what to do differently (esc)",
].join("\n");

const BYPASS_FIXTURE = [
	"\x1b[1mWARNING: Bypass Permissions mode\x1b[0m",
	"",
	"In Bypass Permissions mode, Claude will not ask for your approval before",
	"running tools. This may be dangerous.",
	"",
	"  1. No, exit",
	"  2. Yes, I accept",
].join("\n");

const PASTE_FIXTURE = [
	"Browser didn't open? Open this URL to sign in:",
	"https://claude.ai/oauth/authorize?x=1",
	"",
	"Paste code here if prompted >",
].join("\n");

const PLAIN_FIXTURE = [
	"\x1b[32m●\x1b[0m I've finished the refactor.",
	"",
	"The tests are passing and the build is green.",
	"$ ",
].join("\n");

describe("claudePermissionRecognizer", () => {
	it("has kind 'claude-permission'", () => {
		expect(claudePermissionRecognizer.kind).toBe("claude-permission");
	});

	it("detects a tool-permission prompt, parses options, suggests '1'", () => {
		const out = claudePermissionRecognizer.match(TOOL_FIXTURE, "");
		expect(out).not.toBeNull();
		expect(out?.data.kind).toBe("tool");
		expect(out?.data.question).toBe("Do you want to make this edit?");
		expect(out?.data.options).toEqual([
			"Yes",
			"Yes, and don't ask again for edits in this session",
			"No, and tell Claude what to do differently (esc)",
		]);
		expect(out?.suggestedKeys).toEqual(["1"]);
	});

	it("detects the 'Do you want to proceed?' variant", () => {
		const out = claudePermissionRecognizer.match(PROCEED_FIXTURE, "");
		expect(out?.data.kind).toBe("tool");
		expect(out?.data.question).toBe("Do you want to proceed?");
		expect(out?.suggestedKeys).toEqual(["1"]);
	});

	it("detects a bypass-permissions accept prompt and suggests the accept number", () => {
		const out = claudePermissionRecognizer.match(BYPASS_FIXTURE, "");
		expect(out).not.toBeNull();
		expect(out?.data.kind).toBe("bypass");
		expect(typeof out?.data.question).toBe("string");
		expect(out?.suggestedKeys).toEqual(["2"]);
	});

	it("detects a paste-code login prompt with no suggested keys", () => {
		const out = claudePermissionRecognizer.match(PASTE_FIXTURE, "");
		expect(out).not.toBeNull();
		expect(out?.data.kind).toBe("paste");
		expect(typeof out?.data.question).toBe("string");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("returns null on plain Claude output", () => {
		expect(claudePermissionRecognizer.match(PLAIN_FIXTURE, "")).toBeNull();
	});

	it("falls back to recentBytes when the screen is empty", () => {
		const out = claudePermissionRecognizer.match("", PROCEED_FIXTURE);
		expect(out?.data.kind).toBe("tool");
	});
});
