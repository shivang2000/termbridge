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

import { claudeActivityRecognizer, type SessionManager } from "@termbridge/core";
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
				"env selects the execution backend (local or docker). Set autoApprove:true to have " +
				"termbridge auto-answer the session's routine permission prompts in-session (so a driving " +
				"agent that polls only occasionally never leaves Claude stuck); login is never auto-answered " +
				"and a human takeover pauses it.",
			inputSchema: {
				name: optStr,
				env: z.enum(["local", "docker"]).optional(),
				cwd: optStr,
				repo: optStr,
				branch: optStr,
				cmd: optStr,
				cols: posInt,
				rows: posInt,
				autoApprove: z.boolean().optional(),
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
					autoApprove: args.autoApprove,
				});
				// Report the ACTUAL backend the manager selected — an env policy may
				// coerce an omitted env (e.g. to docker), so don't echo the request.
				const info = manager.list().find((i) => i.id === s.id);
				return { id: s.id, name: s.name, env: info?.env ?? args.env ?? "local" };
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
			name: "read_progress",
			description:
				"One-shot progress poll for a driving loop: returns { delta, nextOffset, events, phase, " +
				"awaitingInput, idle, lastActivityAt }. delta/nextOffset are the new bytes since sinceOffset " +
				"(like read_new_output); events are the recognized events (like read_events). `phase` is the " +
				"claude-activity phase of the CURRENT screen (tool|editing|thinking|awaiting_input|idle|null). " +
				"`idle` is true only when there is no new output AND no active phase — so a pre-painted " +
				"permission prompt or a running spinner correctly reads as NOT idle. `awaitingInput` flags a " +
				"blocking approval. For authoritative round-complete prefer wait_for_idle; use this to stream.",
			inputSchema: { id, sinceOffset: nonNegInt },
			handler: async (args) => {
				const s = require_(args.id);
				const { data: delta, nextOffset } = s.readNewOutput({ sinceOffset: args.sinceOffset });
				const { events } = await s.readEvents({ sinceOffset: args.sinceOffset });
				// Classify the CURRENT screen so `idle` reflects what is painted now, not
				// merely "no bytes since the cursor": a permission prompt or spinner already
				// on screen before this poll must read as NOT idle.
				const screen = await s.readScreen();
				const act = claudeActivityRecognizer.match(screen, delta);
				const phase = (act?.data.phase as string | undefined) ?? null;
				const activeWork =
					phase === "thinking" ||
					phase === "tool" ||
					phase === "editing" ||
					phase === "awaiting_input";
				return {
					delta,
					nextOffset,
					events,
					phase,
					awaitingInput: phase === "awaiting_input",
					idle: delta.length === 0 && !activeWork,
					lastActivityAt: s.lastActivityAt(),
				};
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
			name: "wait_for_event",
			description:
				"Block until a recognizer event (optionally of given kinds) appears, or timeout.",
			inputSchema: {
				id,
				kinds: z.array(z.string()).optional(),
				timeoutMs: posInt,
			},
			handler: async (args) => {
				const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
				const s = require_(args.id);
				const deadline = args.timeoutMs ?? 30000;
				const start = Date.now();
				let sinceOffset = 0;
				for (;;) {
					const { events, nextOffset } = await s.readEvents({ sinceOffset });
					sinceOffset = nextOffset;
					const match = events.filter(
						(e: { kind: string }) => !args.kinds || args.kinds.includes(e.kind),
					);
					if (match.length) {
						return { events: match, timedOut: false, nextOffset };
					}
					if (Date.now() - start >= deadline) {
						return { events: [], timedOut: true, nextOffset };
					}
					await sleep(50);
				}
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
