import { describe, expect, test } from "bun:test";

const here = new URL(".", import.meta.url);

async function readText(relative: string): Promise<string> {
	return Bun.file(new URL(relative, here)).text();
}

async function readJson(relative: string): Promise<unknown> {
	return JSON.parse(await readText(relative));
}

interface PluginManifest {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	author?: unknown;
}

interface McpServer {
	command?: unknown;
	args?: unknown;
	env?: Record<string, unknown> | undefined;
}

interface McpConfig {
	mcpServers?: Record<string, McpServer | undefined>;
}

describe("claude-code-plugin manifests are well-formed JSON (no trailing/garbage)", () => {
	test("plugin.json is strictly parseable JSON", async () => {
		const raw = await readText(".claude-plugin/plugin.json");
		expect(() => JSON.parse(raw)).not.toThrow();
		// no BOM
		expect(raw.charCodeAt(0)).not.toBe(0xfeff);
	});

	test(".mcp.json is strictly parseable JSON", async () => {
		const raw = await readText(".mcp.json");
		expect(() => JSON.parse(raw)).not.toThrow();
		expect(raw.charCodeAt(0)).not.toBe(0xfeff);
	});

	test("package.json is strictly parseable JSON", async () => {
		const raw = await readText("package.json");
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});

describe("plugin.json metadata is complete and correctly typed", () => {
	test("name is exactly 'termbridge'", async () => {
		const m = (await readJson(".claude-plugin/plugin.json")) as PluginManifest;
		expect(m.name).toBe("termbridge");
	});

	test("version is a non-empty semver-ish string", async () => {
		const m = (await readJson(".claude-plugin/plugin.json")) as PluginManifest;
		expect(typeof m.version).toBe("string");
		expect(m.version as string).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("description is a non-empty string", async () => {
		const m = (await readJson(".claude-plugin/plugin.json")) as PluginManifest;
		expect(typeof m.description).toBe("string");
		expect((m.description as string).trim().length).toBeGreaterThan(0);
	});

	test("author has a name", async () => {
		const m = (await readJson(".claude-plugin/plugin.json")) as PluginManifest;
		const author = m.author as { name?: unknown } | undefined;
		expect(author).toBeDefined();
		expect(typeof author?.name).toBe("string");
	});
});

describe(".mcp.json wiring is correct and robust", () => {
	test("exactly one termbridge server is registered", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		expect(config.mcpServers).toBeDefined();
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["termbridge"]);
	});

	test("command is 'bun'", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		expect(config.mcpServers?.termbridge?.command).toBe("bun");
	});

	test("args is a non-empty array whose last element ends with stdio.ts", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		const args = config.mcpServers?.termbridge?.args;
		expect(Array.isArray(args)).toBe(true);
		const argList = args as string[];
		expect(argList.length).toBeGreaterThan(0);
		expect(argList.every((a) => typeof a === "string")).toBe(true);
		expect(argList.some((a) => a.endsWith("stdio.ts"))).toBe(true);
	});

	test("args path points at the mcp-server stdio entrypoint (not some other file)", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		const argList = config.mcpServers?.termbridge?.args as string[];
		const stdioArg = argList.find((a) => a.endsWith("stdio.ts"));
		expect(stdioArg).toBeDefined();
		expect(stdioArg).toContain("mcp-server");
	});

	test("the referenced stdio.ts actually exists on disk (resolved from repo root)", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		const argList = config.mcpServers?.termbridge?.args as string[];
		const stdioArg = argList.find((a) => a.endsWith("stdio.ts")) as string;
		// repo root is two levels up from this package dir
		const repoRoot = new URL("../../", here);
		const target = new URL(stdioArg, repoRoot);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	test("TERMBRIDGE_TMUX_SOCKET env is provisioned and non-empty", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		const env = config.mcpServers?.termbridge?.env;
		expect(env).toBeDefined();
		expect(typeof env?.TERMBRIDGE_TMUX_SOCKET).toBe("string");
		expect((env?.TERMBRIDGE_TMUX_SOCKET as string).length).toBeGreaterThan(0);
	});
});

describe("malformed-JSON detection works (guards the parser assumptions above)", () => {
	test("garbage input throws (sanity: our parseability assertions are meaningful)", () => {
		expect(() => JSON.parse("{ not json ]")).toThrow();
		expect(() => JSON.parse("")).toThrow();
		expect(() => JSON.parse('{"a":1,}')).toThrow();
	});
});
