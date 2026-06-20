import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFileTailer } from "./manager.js";

describe("makeFileTailer", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "termbridge-tailer-"));
		file = join(dir, "pane.log");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns '' before the file exists, never throwing", async () => {
		const tail = makeFileTailer(file);
		expect(await tail()).toBe("");
	});

	test("returns only newly-appended bytes across calls", async () => {
		const tail = makeFileTailer(file);
		await appendFile(file, "hello ");
		expect(await tail()).toBe("hello ");
		// no growth → empty
		expect(await tail()).toBe("");
		await appendFile(file, "world");
		expect(await tail()).toBe("world");
	});

	test("handles multi-byte/unicode and large appends", async () => {
		const tail = makeFileTailer(file);
		const payload = `${"x".repeat(10_000)}🚀ünïcode`;
		await appendFile(file, payload);
		expect(await tail()).toBe(payload);
		expect(await tail()).toBe("");
	});
});
