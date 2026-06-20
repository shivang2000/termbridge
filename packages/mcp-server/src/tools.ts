// Tool specs — the §6 tool surface mapped onto @termbridge/core's SessionManager.
// Each spec is backend-agnostic: it declares a name, a description, a zod RAW
// SHAPE inputSchema (NOT z.object — the SDK's registerTool expects a raw shape),
// and a handler that returns RAW data. server.ts wraps every handler via
// formatTextResponse / formatErrorResponse, so handlers throw on error and
// return plain data on success.
//
// Session-targeted tools resolve the live Session via manager.get(args.id) and
// throw a clean "session not found" error for unknown ids. send_text/send_control
// return the core SendResult AS DATA — including { ok:false, error:"human_driving" }
// when a human is driving — they do NOT throw on that case.

import type { SessionManager } from "@termbridge/core";
import { z } from "zod";

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: z.ZodRawShape;
	handler: (args: any) => Promise<unknown>;
}

const id = z.string();
const optStr = z.string().optional();
const posInt = z.number().int().positive().optional();
const nonNegInt = z.number().int().nonnegative().optional();

export function createToolSpecs(manager: SessionManager): ToolSpec[] {
	/** Resolve a live session or throw a clean not-found error. */
	const require_ = (sid: string) => {
		const s = manager.get(sid);
		if (!s) {
			throw new Error(`session not found: ${sid}`);
		}
		return s;
	};

	return [
		{
			name: "open_session",
			description:
				"Open a new interactive terminal session (tmux substrate) and return its id. " +
				"env selects the execution backend (local or docker).",
			inputSchema: {
				name: optStr,
				env: z.enum(["local", "docker"]).optional(),
				cwd: optStr,
				repo: optStr,
				branch: optStr,
				cmd: optStr,
				cols: posInt,
				rows: posInt,
			},
			handler: async (args) => {
				const s = await manager.open({
					name: args.name,
					env: args.env,
					cwd: args.cwd,
					repo: args.repo,
					branch: args.branch,
					cmd: args.cmd,
					cols: args.cols,
					rows: args.rows,
				});
				return { id: s.id, name: s.name, env: args.env ?? "local" };
			},
		},
		{
			name: "list_sessions",
			description: "List all registered sessions and their state.",
			inputSchema: {},
			handler: async () => {
				return { sessions: manager.list() };
			},
		},
		{
			name: "send_text",
			description:
				"Type text into the session as the agent (optionally pressing Enter). " +
				"Returns the SendResult; { ok:false, error:'human_driving' } when a human is driving.",
			inputSchema: { id, text: z.string(), enter: z.boolean().optional() },
			handler: async (args) => {
				const s = require_(args.id);
				return await s.sendText(args.text, { enter: args.enter });
			},
		},
		{
			name: "send_control",
			description: "Send a control/named key (e.g. 'C-c', 'Up', 'Enter') to the session.",
			inputSchema: { id, key: z.string() },
			handler: async (args) => {
				const s = require_(args.id);
				return await s.sendControl(args.key);
			},
		},
		{
			name: "read_screen",
			description:
				"Capture the current visible pane of the session (optionally including scrollback lines).",
			inputSchema: { id, scrollback: nonNegInt },
			handler: async (args) => {
				const s = require_(args.id);
				return { screen: await s.readScreen({ scrollback: args.scrollback }) };
			},
		},
		{
			name: "read_new_output",
			description:
				"Read bytes appended to the rolling output buffer since sinceOffset; returns { data, nextOffset }.",
			inputSchema: { id, sinceOffset: nonNegInt },
			handler: async (args) => {
				const s = require_(args.id);
				return s.readNewOutput({ sinceOffset: args.sinceOffset });
			},
		},
		{
			name: "wait_for_idle",
			description:
				"Resolve once the session has been quiet for quietMs, or report not-idle at timeoutMs.",
			inputSchema: { id, quietMs: posInt, timeoutMs: posInt },
			handler: async (args) => {
				const s = require_(args.id);
				return await s.waitForIdle(args.quietMs, args.timeoutMs);
			},
		},
		{
			name: "wait_for_text",
			description:
				"Poll the captured screen until pattern matches or timeoutMs elapses; returns { matched, screen }.",
			inputSchema: { id, pattern: z.string(), timeoutMs: posInt },
			handler: async (args) => {
				const s = require_(args.id);
				return await s.waitForText(args.pattern, args.timeoutMs);
			},
		},
		{
			name: "read_events",
			description:
				"Collect newly-recognized interactive events (prompts, takeovers) since sinceOffset.",
			inputSchema: { id, sinceOffset: nonNegInt },
			handler: async (args) => {
				const s = require_(args.id);
				return await s.readEvents({ sinceOffset: args.sinceOffset });
			},
		},
		{
			name: "resize",
			description: "Resize the session's tmux window to cols x rows.",
			inputSchema: {
				id,
				cols: z.number().int().positive(),
				rows: z.number().int().positive(),
			},
			handler: async (args) => {
				const s = require_(args.id);
				await s.resize(args.cols, args.rows);
				return { ok: true };
			},
		},
		{
			name: "close_session",
			description: "Close and deregister a session, tearing down its tmux substrate.",
			inputSchema: { id },
			handler: async (args) => {
				await manager.close(args.id);
				return { ok: true };
			},
		},
	];
}
