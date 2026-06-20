import { describe, expect, test } from "bun:test";

const here = new URL(".", import.meta.url);

async function readJson(relative: string): Promise<unknown> {
	const fileUrl = new URL(relative, here);
	return Bun.file(fileUrl).json();
}

interface PluginManifest {
	name?: unknown;
	description?: unknown;
}

interface McpConfig {
	mcpServers?: Record<string, { command?: unknown; args?: unknown } | undefined>;
}

describe("claude-code-plugin manifests", () => {
	test("plugin.json declares the termbridge plugin", async () => {
		const manifest = (await readJson(".claude-plugin/plugin.json")) as PluginManifest;
		expect(manifest.name).toBe("termbridge");
		expect(typeof manifest.description).toBe("string");
		expect((manifest.description as string).length).toBeGreaterThan(0);
	});

	test(".mcp.json registers the termbridge MCP server via bun + stdio.ts", async () => {
		const config = (await readJson(".mcp.json")) as McpConfig;
		const server = config.mcpServers?.termbridge;
		expect(server).toBeDefined();
		expect(server?.command).toBe("bun");
		const args = server?.args;
		expect(Array.isArray(args)).toBe(true);
		const argList = args as string[];
		expect(argList.some((arg) => arg.endsWith("stdio.ts"))).toBe(true);
	});
});
