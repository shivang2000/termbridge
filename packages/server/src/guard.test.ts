import { describe, expect, test } from "bun:test";
import { extractToken, isAuthorized, isOriginAllowed, safeEqual } from "./guard.js";

describe("safeEqual", () => {
	test("equal strings match", () => {
		expect(safeEqual("s3cret", "s3cret")).toBe(true);
	});
	test("different content / length do not match", () => {
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcd")).toBe(false);
		expect(safeEqual("", "x")).toBe(false);
	});
});

describe("extractToken", () => {
	test("from ?token= query", () => {
		expect(extractToken("http://h/ws/1?token=secret")).toBe("secret");
	});
	test("from Authorization: Bearer", () => {
		expect(extractToken("http://h/ws/1", "Bearer secret")).toBe("secret");
	});
	test("trims trailing whitespace around a Bearer token", () => {
		expect(extractToken("http://h/ws/1", "  Bearer secret \t")).toBe("secret");
	});
	test("query wins over header", () => {
		expect(extractToken("http://h/?token=q", "Bearer hdr")).toBe("q");
	});
	test("none present → empty", () => {
		expect(extractToken("http://h/ws/1")).toBe("");
	});
});

describe("isAuthorized", () => {
	test("no token configured → allowed (tests/opt-out)", () => {
		expect(isAuthorized({ url: "http://h/?token=anything" })).toBe(true);
	});
	test("matching token → allowed", () => {
		expect(isAuthorized({ token: "s", url: "http://h/?token=s" })).toBe(true);
	});
	test("wrong token → denied", () => {
		expect(isAuthorized({ token: "s", url: "http://h/?token=no" })).toBe(false);
	});
	test("missing token when required → denied", () => {
		expect(isAuthorized({ token: "s", url: "http://h/" })).toBe(false);
	});
});

describe("isOriginAllowed (CSWSH defence)", () => {
	test("no Origin (native client) → allowed", () => {
		expect(isOriginAllowed(undefined, ["http://localhost:8787"])).toBe(true);
	});
	test("allowlisted browser Origin → allowed", () => {
		expect(isOriginAllowed("http://localhost:8787", ["http://localhost:8787"])).toBe(true);
	});
	test("off-origin page → denied", () => {
		expect(isOriginAllowed("https://evil.example", ["http://localhost:8787"])).toBe(false);
	});
});
