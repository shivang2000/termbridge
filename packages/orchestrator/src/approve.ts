// approve.ts — in-session approval glue. Factored out of engineer-loop.ts (P1.3).
// If the session is blocked on a permission/trust prompt, accept the highlighted
// default (Yes) so a driving agent that polls only occasionally never leaves the
// TUI stuck waiting for input. (The heavier auto-approve loop lives in core's
// Session; this is the loop-driver-level one-shot check.)

import type { ProgressResult, ToolCall } from "./types.js";

/** If the session is blocked on an approval, accept the highlighted default (Yes). */
export async function approveIfBlocked(tools: ToolCall, id: string): Promise<boolean> {
	const p = (await tools("read_progress", { id, sinceOffset: 0 })) as ProgressResult;
	if (p.awaitingInput || p.phase === "awaiting_input") {
		await tools("send_control", { id, key: "Enter" });
		await tools("wait_for_idle", { id, quietMs: 1500, timeoutMs: 30000 });
		return true;
	}
	return false;
}
