import { describe, expect, it } from "bun:test";
import { genericYnRecognizer } from "./generic-yn.js";

const r = genericYnRecognizer;

describe("genericYnRecognizer (adversarial)", () => {
	// Bare CR overwrites — DEFECT FOUND + FIXED.
	it("collapses a progress redraw before the prompt (bare CR)", () => {
		const out = r.match("50%\r100%\rOverwrite? [y/N]", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Overwrite? [y/N]");
		expect(out?.data.default).toBe("n");
		expect(out?.data.prompt as string).not.toContain("\r");
	});

	it("does not lose the prompt on a trailing bare CR", () => {
		const out = r.match("Continue? [Y/n] \r", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Continue? [Y/n]");
		expect(out?.data.default).toBe("y");
	});

	it("redraws over a longer earlier line then finds the marker", () => {
		const out = r.match("Downloading deps...\rProceed? [y/N]", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt as string).toContain("[y/N]");
		expect(out?.data.prompt as string).not.toContain("\r");
	});

	// DCS / string escape sequences — DEFECT FOUND + FIXED.
	it("strips a DCS sequence preceding the prompt", () => {
		const out = r.match("\x1bP1;2|payload\x1b\\Proceed (y/n)? ", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Proceed (y/n)?");
		expect(out?.data.prompt as string).not.toContain("\x1b");
	});

	it("strips an APC sequence preceding the prompt", () => {
		const out = r.match("\x1b_some-app-cmd\x1b\\Continue? [Y/n] ", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Continue? [Y/n]");
		expect(out?.data.prompt as string).not.toContain("\x1b");
	});

	// OSC sequences (BEL + ST terminators).
	it("strips an OSC title (BEL-terminated) before the marker", () => {
		const out = r.match("\x1b]0;my-title\x07Delete? [y/N] ", "");
		expect(out?.data.prompt).toBe("Delete? [y/N]");
	});

	it("strips an OSC sequence (ST-terminated) before the marker", () => {
		const out = r.match("\x1b]0;t\x1b\\Delete? [y/N] ", "");
		expect(out?.data.prompt).toBe("Delete? [y/N]");
	});

	// Heavy ANSI noise.
	it("matches with cursor-move + SGR noise wrapping the marker", () => {
		const screen = "\x1b[2K\x1b[1G\x1b[31mAre you sure\x1b[0m \x1b[1;33m[Y/n]\x1b[0m\x1b[?25h ";
		const out = r.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Are you sure [Y/n]");
		expect(out?.data.default).toBe("y");
	});

	// Casing variants.
	it("treats (YES/NO) as the long form with no default", () => {
		const out = r.match("Wipe disk? (YES/NO) ", "");
		expect(out).not.toBeNull();
		expect(out?.data.default).toBeNull();
		expect(out?.suggestedKeys).toEqual(["y"]);
	});

	it("matches mixed-case (Yes/No)", () => {
		const out = r.match("Confirm? (Yes/No) ", "");
		expect(out).not.toBeNull();
		expect(out?.data.default).toBeNull();
	});

	it("matches [y/n] (both lowercase) with no default", () => {
		const out = r.match("Go ahead? [y/n] ", "");
		expect(out).not.toBeNull();
		expect(out?.data.default).toBeNull();
		expect(out?.suggestedKeys).toEqual(["y"]);
	});

	// Prompt NOT at the very end.
	it("ignores trailing blank lines after the prompt", () => {
		const out = r.match("Remove? [y/N]\n\n\n   \n", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Remove? [y/N]");
	});

	it("picks the LAST marker line when several are present", () => {
		const screen = "First? [y/N]\nSecond? [Y/n]\n";
		const out = r.match(screen, "");
		expect(out?.data.prompt).toBe("Second? [Y/n]");
		expect(out?.data.default).toBe("y");
	});

	it("returns the most recent marker even with trailing non-marker prose", () => {
		const screen = "Overwrite? [y/N]\nthinking...\nworking...\n";
		const out = r.match(screen, "");
		expect(out?.data.prompt).toBe("Overwrite? [y/N]");
	});

	// Negative / garbage.
	it("returns null for empty string", () => {
		expect(r.match("", "")).toBeNull();
	});

	it("returns null for whitespace-only screen", () => {
		expect(r.match("   \n\t\n  \r\n", "")).toBeNull();
	});

	it("returns null for pure ANSI/control noise with no marker", () => {
		expect(r.match("\x1b[2J\x1b[H\x1b[?25l\x07\x08", "")).toBeNull();
	});

	it("returns null for a reversed [n/y] order (not a recognised marker)", () => {
		expect(r.match("Pick? [n/y] ", "")).toBeNull();
	});

	it("returns null for spaced-out brackets [ y / N ]", () => {
		expect(r.match("Go? [ y / N ] ", "")).toBeNull();
	});

	it("returns null when 'yes'/'no' appear as prose, not a marker", () => {
		expect(r.match("Answer yes or no to continue.\n$ ", "")).toBeNull();
	});

	it("returns null for a bare y/n with slash but no brackets", () => {
		expect(r.match("mode is y/n switching\n", "")).toBeNull();
	});

	// Unicode.
	it("matches with leading unicode/emoji content", () => {
		const out = r.match("⚠️  Удалить файл? [y/N] ", "");
		expect(out).not.toBeNull();
		expect(out?.data.default).toBe("n");
		expect(out?.data.prompt as string).toContain("[y/N]");
	});

	it("matches when the prompt contains CJK characters", () => {
		const out = r.match("继续吗? [Y/n] ", "");
		expect(out).not.toBeNull();
		expect(out?.data.default).toBe("y");
	});

	// Result shape.
	it("never returns kind on the payload (only data + suggestedKeys)", () => {
		const out = r.match("Continue? [y/N] ", "");
		expect(out).not.toBeNull();
		expect(out).not.toHaveProperty("kind");
		expect(Object.keys(out as object).sort()).toEqual(["data", "suggestedKeys"]);
	});

	it("always returns a single-element suggestedKeys array", () => {
		for (const s of ["x? [y/N]", "x? [Y/n]", "x? [y/n]", "x? (yes/no)"]) {
			const out = r.match(s, "");
			expect(out?.suggestedKeys).toHaveLength(1);
		}
	});

	it("suggestedKeys mirrors the default when one exists", () => {
		expect(r.match("a [y/N]", "")?.suggestedKeys).toEqual(["n"]);
		expect(r.match("a [Y/n]", "")?.suggestedKeys).toEqual(["y"]);
	});

	it("ignores recentBytes arg entirely (matches on screen only)", () => {
		expect(r.match("nothing here\n", "Overwrite? [y/N]")).toBeNull();
		expect(r.match("Overwrite? [y/N]", "irrelevant")).not.toBeNull();
	});

	// Realistic noisy multi-line screen.
	it("finds the prompt at the bottom of a busy screen", () => {
		const screen =
			"\x1b[2J\x1b[H" +
			"$ npm install\n" +
			"\x1b[32m+\x1b[0m added 412 packages\n" +
			"\rProgress: 100%\n" +
			"\n" +
			"\x1b[1mApply changes to 12 files?\x1b[0m \x1b[2m[Y/n]\x1b[0m \n" +
			"\n";
		const out = r.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Apply changes to 12 files? [Y/n]");
		expect(out?.data.default).toBe("y");
		expect(out?.suggestedKeys).toEqual(["y"]);
	});
});
