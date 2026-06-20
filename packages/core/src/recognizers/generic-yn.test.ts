import { describe, expect, it } from "bun:test";
import { genericYnRecognizer } from "./generic-yn.js";

describe("genericYnRecognizer", () => {
	it("has kind 'generic-yn'", () => {
		expect(genericYnRecognizer.kind).toBe("generic-yn");
	});

	it("matches [y/N] with default n", () => {
		const out = genericYnRecognizer.match("Overwrite file? [y/N] ", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Overwrite file? [y/N]");
		expect(out?.data.default).toBe("n");
		expect(out?.suggestedKeys).toEqual(["n"]);
	});

	it("matches [Y/n] with default y", () => {
		const out = genericYnRecognizer.match("Continue? [Y/n] ", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Continue? [Y/n]");
		expect(out?.data.default).toBe("y");
		expect(out?.suggestedKeys).toEqual(["y"]);
	});

	it("matches (y/n) with no default and suggests 'y'", () => {
		const out = genericYnRecognizer.match("Proceed (y/n)? ", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Proceed (y/n)?");
		expect(out?.data.default).toBeNull();
		expect(out?.suggestedKeys).toEqual(["y"]);
	});

	it("matches (yes/no) prompts", () => {
		const out = genericYnRecognizer.match("Are you sure? (yes/no) ", "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Are you sure? (yes/no)");
		expect(out?.data.default).toBeNull();
		expect(out?.suggestedKeys).toEqual(["y"]);
	});

	it("picks the last non-empty line containing the marker on a multi-line screen", () => {
		const screen =
			"Installing packages...\n" +
			"Resolved 42 dependencies\n" +
			"\n" +
			"Do you want to continue? [Y/n] \n" +
			"\n";
		const out = genericYnRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Do you want to continue? [Y/n]");
		expect(out?.data.default).toBe("y");
		expect(out?.suggestedKeys).toEqual(["y"]);
	});

	it("ignores ANSI escapes when matching", () => {
		const screen = "\x1b[1mDelete everything?\x1b[0m \x1b[33m[y/N]\x1b[0m ";
		const out = genericYnRecognizer.match(screen, "");
		expect(out).not.toBeNull();
		expect(out?.data.prompt).toBe("Delete everything? [y/N]");
		expect(out?.data.default).toBe("n");
		expect(out?.suggestedKeys).toEqual(["n"]);
	});

	it("returns null for plain output with no y/n prompt", () => {
		expect(genericYnRecognizer.match("Build succeeded.\n$ ", "")).toBeNull();
	});

	it("returns null for a bare 'y' with no brackets", () => {
		expect(genericYnRecognizer.match("the value is y\n", "")).toBeNull();
	});
});
