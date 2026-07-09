import { afterEach, describe, expect, it } from "bun:test";
import { E2BSandboxProvider } from "./e2b-provider.js";
import { sandboxProviderFromEnv } from "./from-env.js";

describe("sandboxProviderFromEnv", () => {
	const prev = process.env.E2B_API_KEY;
	afterEach(() => {
		if (prev === undefined) delete process.env.E2B_API_KEY;
		else process.env.E2B_API_KEY = prev;
	});

	it("returns undefined when no key is available", () => {
		delete process.env.E2B_API_KEY;
		expect(sandboxProviderFromEnv()).toBeUndefined();
	});

	it("returns an E2BSandboxProvider when E2B_API_KEY is set", () => {
		process.env.E2B_API_KEY = "test-key";
		const p = sandboxProviderFromEnv();
		expect(p).toBeInstanceOf(E2BSandboxProvider);
		expect(p?.name).toBe("e2b");
	});

	it("prefers an explicit apiKey over the env", () => {
		process.env.E2B_API_KEY = "env-key";
		const p = sandboxProviderFromEnv({ apiKey: "explicit" });
		expect(p).toBeInstanceOf(E2BSandboxProvider);
	});
});
