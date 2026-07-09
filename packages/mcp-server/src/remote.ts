// remote.ts — proxy mode: forward tool calls to a running unified server's HTTP
// tool API instead of an in-process SessionManager, so the browser (served by
// that server) watches the exact sessions this MCP drives. Lifted from
// scripts/engineer.ts's HTTP client; keys ONLY on the outer {ok} envelope.
import { tmpdir } from "node:os";
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
		// SECURITY: send the bearer token via the Authorization header, not the URL
		// query string, so it never leaks into server access logs / proxy logs / URL
		// history. The server's extractToken reads the header; ?token= stays a
		// supported fallback (used by the browser WS, which cannot set headers).
		const res = await f(`${base}/api/tool/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
			body: JSON.stringify(args ?? {}),
		});
		const j = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
		if (!j.ok) throw new Error(j.error ?? `tool ${name} failed (${res.status})`);
		return j.data;
	};
}

/** Reuse createToolSpecs ONLY for name/description/inputSchema; swap each handler
 *  to the remote caller. The throwaway manager is NEVER opened (no tmux/observer);
 *  pipeDir is set to the existing OS tmpdir so construction allocates nothing (no
 *  default mkdtemp), and TERMBRIDGE_HOME is unset in proxy mode → no auth dir either. */
export function createRemoteToolSpecs(caller: RemoteCaller): ToolSpec[] {
	return createToolSpecs(new SessionManager({ pipeDir: tmpdir() })).map((s) => ({
		name: s.name,
		description: s.description,
		inputSchema: s.inputSchema,
		handler: (args: unknown) => caller(s.name, args),
	}));
}
