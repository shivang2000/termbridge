import { describe, expect, it } from "bun:test";
import { claudeActivityRecognizer } from "./claude-activity.js";

describe("claudeActivityRecognizer", () => {
	it("has kind 'claude-activity'", () => {
		expect(claudeActivityRecognizer.kind).toBe("claude-activity");
	});

	// --- tool phase ---------------------------------------------------------

	it("detects a tool line (Update) and extracts tool + file", () => {
		const screen =
			"I'll update the manifest now.\n" +
			"● Update(package.json)\n" +
			"  ⎿ Updating dependencies…\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Update");
		expect(out?.data.file).toBe("package.json");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("detects a Bash tool line (no file path extracted)", () => {
		const screen = "● Bash(bun run test)\n  ⎿ Running tests…\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Bash");
		expect(out?.data.file).toBeUndefined();
	});

	it("detects a Read tool line and extracts the file arg", () => {
		const screen = "● Read(src/index.ts)\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Read");
		expect(out?.data.file).toBe("src/index.ts");
	});

	it("detects a Search tool line", () => {
		const screen = "● Search(pattern: foo)\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Search");
	});

	it("detects a Write tool line and extracts the file", () => {
		const screen = "● Write(docs/NEW.md)\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Write");
		expect(out?.data.file).toBe("docs/NEW.md");
	});

	// --- thinking phase -----------------------------------------------------

	it("detects a thinking spinner (✻ + elapsed seconds)", () => {
		const screen = "✻ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.phase).toBe("thinking");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("detects a thinking spinner via the Cogitated word", () => {
		const screen = "✻ Cogitated (8s)\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("thinking");
	});

	// --- awaiting_input phase ----------------------------------------------

	it("detects an edit-permission prompt as awaiting_input", () => {
		const screen =
			"● Update(src/app.ts)\n" +
			"Do you want to make this edit to app.ts?\n" +
			"❯ 1. Yes\n" +
			"  2. No\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.phase).toBe("awaiting_input");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("detects a trust-folder prompt as awaiting_input", () => {
		const screen =
			"Do you trust the files in this folder?\n" + "❯ 1. Yes, proceed\n" + "  2. No, exit\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("awaiting_input");
	});

	it("awaiting_input wins over a tool line in the same tail", () => {
		const screen =
			"● Update(config.json)\n" + "Do you want to make this edit?\n" + "❯ 1. Yes\n" + "  2. No\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("awaiting_input");
	});

	// --- editing phase ------------------------------------------------------

	it("detects an editing diff block (+/- lines under an Update)", () => {
		const screen =
			"● Update(src/sum.ts)\n" +
			"  ⎿ Updated src/sum.ts\n" +
			"     1  - return a;\n" +
			"     2  + return a + b;\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.phase).toBe("editing");
		expect(out?.data.file).toBe("src/sum.ts");
	});

	// --- responding / idle phase -------------------------------------------

	it("reports idle when only the empty prompt box is present", () => {
		const screen =
			"Done. Let me know if you need anything else.\n" +
			"\n" +
			"╭──────────────────────────────╮\n" +
			"│ ❯                            │\n" +
			"╰──────────────────────────────╯\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.phase).toBe("idle");
		expect(out?.suggestedKeys).toEqual([]);
	});

	it("does NOT report idle when a spinner is active above the prompt box", () => {
		const screen =
			"✻ Cogitating… (3s · esc to interrupt)\n" +
			"╭──────────────────────────────╮\n" +
			"│ ❯                            │\n" +
			"╰──────────────────────────────╯\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("thinking");
	});

	it("reports tool (not idle) while a tool is actively running above the prompt box (spinner up)", () => {
		const screen =
			"● Bash(bun run build)\n" +
			"  ⎿ Running… (4s · esc to interrupt)\n" +
			"╭──────────────────────────────╮\n" +
			"│ ❯                            │\n" +
			"╰──────────────────────────────╯\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("tool");
	});

	// --- negatives ----------------------------------------------------------

	it("returns null for a plain shell prompt (no Claude TUI markers)", () => {
		const screen = "$ ls -la\ntotal 8\ndrwxr-xr-x  2 me me 64 Jun 21 10:00 .\n$ ";
		expect(claudeActivityRecognizer.match(screen, "")).toBeNull();
	});

	it("returns null for a zsh-style ❯ shell prompt with no Claude box", () => {
		const screen = "~/dev/termbridge ❯ git status\nnothing to commit\n~/dev/termbridge ❯ ";
		expect(claudeActivityRecognizer.match(screen, "")).toBeNull();
	});

	it("returns null for ordinary test output", () => {
		const screen = "✓ 42 tests passed\n✗ 0 failed\nRan in 1.2s\n";
		expect(claudeActivityRecognizer.match(screen, "")).toBeNull();
	});

	it("returns null for a README bullet using the ● glyph", () => {
		const screen =
			"# Features\n" + "● Fast startup\n" + "● Pluggable backends\n" + "Read the docs above.\n";
		expect(claudeActivityRecognizer.match(screen, "")).toBeNull();
	});

	it("returns null for ANSI-laden plain output with no markers", () => {
		const screen = "\x1b[32mBuild succeeded\x1b[0m\n\x1b[2mcompiled in 0.4s\x1b[0m\n";
		expect(claudeActivityRecognizer.match(screen, "")).toBeNull();
	});

	it("strips ANSI around a tool line and still detects it", () => {
		const screen = "\x1b[1m● Update(\x1b[33mpackage.json\x1b[0m)\x1b[0m\n";
		const out = claudeActivityRecognizer.match(screen, "");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Update");
		expect(out?.data.file).toBe("package.json");
	});

	it("falls back to recentBytes when the screen is blank", () => {
		const out = claudeActivityRecognizer.match("   \n  \n", "● Read(main.ts)\n");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Read");
	});
});

// Hardening against the adversarial review: border tolerance, MCP names,
// version-stable spinner, never-settles, broad approvals, and false positives.
describe("claudeActivityRecognizer — robustness (M7 hardening)", () => {
	const R = claudeActivityRecognizer;

	it("tolerates a leading/trailing box border around a tool line", () => {
		const out = R.match("│ ● Update(package.json)                         │\n", "");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("Update");
		expect(out?.data.file).toBe("package.json");
	});

	it("recognizes an MCP / underscored tool name", () => {
		const out = R.match("● mcp__server__tool(arg)\n", "");
		expect(out?.data.phase).toBe("tool");
		expect(out?.data.tool).toBe("mcp__server__tool");
	});

	it("detects a rotated spinner verb/glyph via the stable 'esc to interrupt' signal", () => {
		const screen =
			"✶ Puzzling… (3s · esc to interrupt)\n" +
			"╭──────────────────────────────╮\n" +
			"│ ❯                            │\n" +
			"╰──────────────────────────────╯\n";
		expect(R.match(screen, "")?.data.phase).toBe("thinking");
	});

	it("reports IDLE when a COMPLETED tool bullet sits above the empty box (never-settles fix)", () => {
		const screen =
			"● Read(src/index.ts)\n" +
			"  ⎿ Read 120 lines\n" +
			"Here is what I found. Anything else?\n" +
			"╭──────────────────────────────╮\n" +
			"│ ❯                            │\n" +
			"╰──────────────────────────────╯\n";
		expect(R.match(screen, "")?.data.phase).toBe("idle");
	});

	it("treats a non-edit approval (bash command) as awaiting_input via the ❯ N. cursor", () => {
		const screen =
			"● Bash(rm -rf build)\n" + "Allow this command to run?\n" + "❯ 1. Yes\n" + "  2. No\n";
		expect(R.match(screen, "")?.data.phase).toBe("awaiting_input");
	});

	it("does NOT set file for non-file tools (Glob/Bash args are not files)", () => {
		expect(R.match("● Glob(src/**/*.ts)\n", "")?.data.file).toBeUndefined();
		expect(R.match("● Bash(./run.sh)\n", "")?.data.file).toBeUndefined();
	});

	// --- false positives that must NOT trip a phase ---

	it("a bare ✻ glyph in decorative text is NOT a spinner", () => {
		expect(R.match("Highlights:\n✻ blazing fast\n✻ tiny\n", "")).toBeNull();
	});

	it("a markdown blockquote '> 1.' next to prompt wording is NOT awaiting_input", () => {
		const screen = "Do you want to proceed?\n> 1. Continue\n> 2. Abort\n";
		expect(R.match(screen, "")).toBeNull();
	});

	it("a vim/status '│ ❯ text' line (no rounded frame) is NOT idle", () => {
		expect(R.match("NORMAL │ main │ ❯ utf-8 │ 12:34\n", "")).toBeNull();
	});

	it("a lazygit-style rounded box whose arrow has real text is NOT idle", () => {
		const screen =
			"╭─ Branches ───────────────────╮\n" +
			"│ ❯ feature-branch             │\n" +
			"│   main                       │\n" +
			"╰──────────────────────────────╯\n";
		expect(R.match(screen, "")?.data.phase).not.toBe("idle");
	});

	it("a markdown table cell with ❯ is NOT idle", () => {
		expect(R.match("| col | val |\n| ❯ x | 1 |\n", "")).toBeNull();
	});

	it("ANSI between the border bar and ❯ does not fake an idle box", () => {
		expect(R.match("\x1b[34m│\x1b[0m ❯ cmd\n", "")).toBeNull();
	});
});
