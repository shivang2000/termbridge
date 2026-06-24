// remote.ts — proxy mode: forward tool calls to a running unified server's HTTP
// tool API instead of an in-process SessionManager, so the browser (served by
// that server) watches the exact sessions this MCP drives. Lifted from
// scripts/engineer.ts's HTTP client; keys ONLY on the outer {ok} envelope.
import { SessionManager } from "@termbridge/core";
import { createToolSpecs, type ToolSpec } from "./tools.js";

export interface RemoteOptions {
	serverUrl: string;
	token: string;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

export type RemoteCaller = (name: string, args: unknown) => Promise<unknown>;

export function createRemoteCaller(opts: RemoteOptions): RemoteCaller {
	const base = opts.serverUrl.replace(/\/$/, "");
	const f = opts.fetchImpl ?? fetch;
	return async (name, args) => {
		const res = await f(`${base}/api/tool/${name}?token=${encodeURIComponent(opts.token)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(args ?? {}),
		});
		const j = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
		if (!j.ok) throw new Error(j.error ?? `tool ${name} failed (${res.status})`);
		return j.data;
	};
}

/** Reuse createToolSpecs ONLY for name/description/inputSchema; swap each handler
 *  to the remote caller. The throwaway manager is never opened (no tmux/observer);
 *  in proxy mode TERMBRIDGE_HOME is unset so its construction has no side effects. */
export function createRemoteToolSpecs(caller: RemoteCaller): ToolSpec[] {
	return createToolSpecs(new SessionManager()).map((s) => ({
		name: s.name,
		description: s.description,
		inputSchema: s.inputSchema,
		handler: (args: unknown) => caller(s.name, args),
	}));
}
