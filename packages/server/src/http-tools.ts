// HTTP tool dispatch — exposes the SAME §6 tool surface as the MCP server over
// plain HTTP JSON, sharing the unified server's single SessionManager. This is
// what lets an agent and the web UI drive ONE session (so WriteLock arbitrates
// across them). The formal MCP stdio transport (M3) remains the canonical
// agent interface; this reuses `createToolSpecs` so there is no second tool
// definition. A streamable-HTTP MCP transport can wrap the same specs later.

import type { SessionManager } from "@termbridge/core";
import { createToolSpecs, type ToolSpec } from "@termbridge/mcp-server";
import { z } from "zod";

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolDispatch {
	names: string[];
	call(name: string, body: unknown): Promise<ToolResult>;
}

/** Build a name→handler dispatch over the §6 tools, with zod-validated input. */
export function createToolDispatch(manager: SessionManager): ToolDispatch {
	const specs = createToolSpecs(manager);
	const byName = new Map<string, ToolSpec>(specs.map((s) => [s.name, s]));
	return {
		names: specs.map((s) => s.name),
		async call(name, body): Promise<ToolResult> {
			const spec = byName.get(name);
			if (!spec) {
				return { ok: false, error: `unknown tool: ${name}` };
			}
			try {
				const args = z.object(spec.inputSchema).parse(body ?? {});
				const data = await spec.handler(args);
				return { ok: true, data };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}
