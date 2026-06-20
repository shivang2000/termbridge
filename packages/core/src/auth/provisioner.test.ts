import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthProvisioner } from "./provisioner.js";

describe("AuthProvisioner", () => {
	let homeDir: string;

	beforeEach(() => {
		homeDir = mkdtempSync(join(tmpdir(), "tb-auth-"));
	});

	afterEach(() => {
		rmSync(homeDir, { recursive: true, force: true });
	});

	// ---- contract tests (from the spec) ----------------------------------

	test("homeDir is exposed from options", () => {
		const ap = new AuthProvisioner({ homeDir });
		expect(ap.homeDir).toBe(homeDir);
	});

	test("isLoggedIn() is false before login", () => {
		const ap = new AuthProvisioner({ homeDir });
		expect(ap.isLoggedIn()).toBe(false);
	});

	test("ensureReady() creates homeDir/.claude", () => {
		const ap = new AuthProvisioner({ homeDir });
		const claudeDir = join(homeDir, ".claude");
		expect(existsSync(claudeDir)).toBe(false);
		ap.ensureReady();
		expect(existsSync(claudeDir)).toBe(true);
		expect(statSync(claudeDir).isDirectory()).toBe(true);
	});

	test("ensureReady() is idempotent (recursive, no throw on existing dir)", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		expect(() => ap.ensureReady()).not.toThrow();
		expect(existsSync(join(homeDir, ".claude"))).toBe(true);
	});

	test("isLoggedIn() is true after a non-empty .credentials.json exists", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), JSON.stringify({ token: "abc" }));
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("isLoggedIn() is false for an empty credentials file (size 0)", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), "");
		expect(statSync(join(homeDir, ".claude", ".credentials.json")).size).toBe(0);
		expect(ap.isLoggedIn()).toBe(false);
	});

	test("isLoggedIn() never throws when the home dir does not exist", () => {
		const ap = new AuthProvisioner({ homeDir: join(homeDir, "missing", "nested") });
		expect(() => ap.isLoggedIn()).not.toThrow();
		expect(ap.isLoggedIn()).toBe(false);
	});

	test("homeEnv() returns { HOME: homeDir }", () => {
		const ap = new AuthProvisioner({ homeDir });
		expect(ap.homeEnv()).toEqual({ HOME: homeDir });
	});

	// ---- ADVERSARIAL edge cases ------------------------------------------

	test("ensureReady() creates the FULL chain when parent dirs are missing", () => {
		const deep = join(homeDir, "a", "b", "c");
		const ap = new AuthProvisioner({ homeDir: deep });
		expect(() => ap.ensureReady()).not.toThrow();
		expect(statSync(join(deep, ".claude")).isDirectory()).toBe(true);
	});

	test("isLoggedIn() is FALSE when .credentials.json is a DIRECTORY, not a file", () => {
		// A directory entry named .credentials.json exists() => true and on most
		// filesystems has size > 0. A naive existsSync+size check wrongly reports
		// "logged in". The CLI cannot read creds from a directory.
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		mkdirSync(join(homeDir, ".claude", ".credentials.json"));
		expect(ap.isLoggedIn()).toBe(false);
	});

	test("isLoggedIn() is false when only .claude dir exists (no creds file)", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		expect(ap.isLoggedIn()).toBe(false);
	});

	test("isLoggedIn() is true for a single-byte (whitespace) creds file", () => {
		// size > 0 is the contract; content is not parsed at this layer.
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), " ");
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("isLoggedIn() reflects later writes (not cached at construction)", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		expect(ap.isLoggedIn()).toBe(false);
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), "x");
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("isLoggedIn() follows a symlink to a real non-empty creds file", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		const realCreds = join(homeDir, "real-creds.json");
		writeFileSync(realCreds, JSON.stringify({ token: "t" }));
		symlinkSync(realCreds, join(homeDir, ".claude", ".credentials.json"));
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("isLoggedIn() is false for a symlink pointing at a missing target (dangling)", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		symlinkSync(
			join(homeDir, "does-not-exist.json"),
			join(homeDir, ".claude", ".credentials.json"),
		);
		expect(() => ap.isLoggedIn()).not.toThrow();
		expect(ap.isLoggedIn()).toBe(false);
	});

	test("works with a homeDir containing spaces", () => {
		const spaced = mkdtempSync(join(tmpdir(), "tb auth spaces "));
		try {
			const ap = new AuthProvisioner({ homeDir: spaced });
			ap.ensureReady();
			expect(statSync(join(spaced, ".claude")).isDirectory()).toBe(true);
			writeFileSync(join(spaced, ".claude", ".credentials.json"), "{}");
			expect(ap.isLoggedIn()).toBe(true);
			expect(ap.homeEnv()).toEqual({ HOME: spaced });
		} finally {
			rmSync(spaced, { recursive: true, force: true });
		}
	});

	test("works with a homeDir containing unicode", () => {
		const uni = mkdtempSync(join(tmpdir(), "tb-auth-日本語-café-"));
		try {
			const ap = new AuthProvisioner({ homeDir: uni });
			ap.ensureReady();
			writeFileSync(join(uni, ".claude", ".credentials.json"), "{}");
			expect(ap.isLoggedIn()).toBe(true);
			expect(ap.homeEnv()).toEqual({ HOME: uni });
		} finally {
			rmSync(uni, { recursive: true, force: true });
		}
	});

	test("homeDir with a trailing slash still resolves the creds path", () => {
		const ap = new AuthProvisioner({ homeDir: `${homeDir}/` });
		ap.ensureReady();
		// join() normalizes the doubled slash; write via the normalized path.
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), "{}");
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("homeEnv() returns exactly one key (HOME) and nothing else", () => {
		const ap = new AuthProvisioner({ homeDir });
		expect(Object.keys(ap.homeEnv())).toEqual(["HOME"]);
	});

	test("homeEnv() returns a fresh object each call (no shared mutable state)", () => {
		const ap = new AuthProvisioner({ homeDir });
		const a = ap.homeEnv();
		const b = ap.homeEnv();
		expect(a).not.toBe(b);
		a.HOME = "tampered";
		expect(ap.homeEnv().HOME).toBe(homeDir);
		expect(ap.homeDir).toBe(homeDir);
	});

	test("homeDir is readonly: mutating the options object after construction has no effect", () => {
		const opts = { homeDir };
		const ap = new AuthProvisioner(opts);
		opts.homeDir = "/somewhere/else";
		expect(ap.homeDir).toBe(homeDir);
		expect(ap.homeEnv()).toEqual({ HOME: homeDir });
	});

	test("isLoggedIn() does not require ensureReady() to have been called", () => {
		// creds dropped onto the volume out-of-band (e.g. a mounted volume).
		const ap = new AuthProvisioner({ homeDir });
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), "{}");
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("ensureReady() does not create or clobber a credentials file", () => {
		const ap = new AuthProvisioner({ homeDir });
		ap.ensureReady();
		const creds = join(homeDir, ".claude", ".credentials.json");
		writeFileSync(creds, JSON.stringify({ token: "keep-me" }));
		ap.ensureReady(); // second call must not wipe the file
		expect(existsSync(creds)).toBe(true);
		expect(statSync(creds).size).toBeGreaterThan(0);
		expect(ap.isLoggedIn()).toBe(true);
	});

	test("empty-string homeDir resolves relative to cwd and never throws", () => {
		// Defensive: an empty homeDir is a misconfiguration but must not crash.
		const ap = new AuthProvisioner({ homeDir: "" });
		expect(() => ap.isLoggedIn()).not.toThrow();
		expect(typeof ap.isLoggedIn()).toBe("boolean");
		expect(ap.homeEnv()).toEqual({ HOME: "" });
	});
});
