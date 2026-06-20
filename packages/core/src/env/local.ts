// LocalEnvironment — runs tmux directly on the host (D4 "Local"). It is the M1
// concrete `Environment`: every method delegates to `TmuxHelpers`, which routes
// through an injectable `ExecFn` so this whole unit is testable with a mock and
// never spawns a real tmux. The agent layer NEVER attaches — it only issues
// tmux CLI commands through `tmux()` (D1).

import { DEFAULT_TMUX_SOCKET, defaultExec, TmuxHelpers, withTmuxSocket } from "../tmux/helpers.js";
import type { EnsureSessionOptions, Environment, ExecFn, ExecResult, TermSize } from "../types.js";

export interface LocalEnvironmentOptions {
	/**
	 * Injectable command runner. Defaults to the real `execFile`-backed exec,
	 * pinned to a dedicated `-L <socket>` tmux server (see {@link withTmuxSocket}).
	 * A custom `exec` is used verbatim — the caller owns its tmux isolation.
	 */
	exec?: ExecFn;
	/**
	 * Dedicated tmux socket name for the default exec. Defaults to
	 * `TERMBRIDGE_TMUX_SOCKET` or `"termbridge"`. Ignored when a custom `exec`
	 * is supplied.
	 */
	socket?: string;
}

export class LocalEnvironment implements Environment {
	readonly kind = "local" as const;

	private readonly exec: ExecFn;
	private readonly tmuxHelpers: TmuxHelpers;

	constructor(opts: LocalEnvironmentOptions = {}) {
		const socket = opts.socket ?? process.env.TERMBRIDGE_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET;
		// SAFETY: the real exec is pinned to a dedicated `-L <socket>` server so
		// termbridge can never see or kill the user's default tmux sessions.
		this.exec = opts.exec ?? withTmuxSocket(defaultExec, socket);
		this.tmuxHelpers = new TmuxHelpers(this.exec);
	}

	async ensureSession(opts: EnsureSessionOptions): Promise<void> {
		// Reuse the tmux helper — do NOT duplicate argv logic here.
		await this.tmuxHelpers.newSession({
			name: opts.name,
			cwd: opts.cwd,
			cmd: opts.cmd,
			cols: opts.cols,
			rows: opts.rows,
			env: opts.env,
		});
	}

	/**
	 * Raw tmux passthrough. Used by `Session` for capture-pane, send-keys,
	 * resize-window, pipe-pane, etc. so the higher layers never re-implement the
	 * argv. Returns the `ExecResult` verbatim (never rejects on non-zero exit).
	 */
	async tmux(args: string[]): Promise<ExecResult> {
		return this.exec("tmux", args);
	}

	/** Declared in M1, implemented in M5 (node-pty running `tmux attach`). */
	attachPty(_name: string, _size: TermSize): unknown {
		throw new Error("attachPty is implemented in M5");
	}

	async destroySession(name: string): Promise<void> {
		await this.tmuxHelpers.killSession(name);
	}

	async listSessions(): Promise<string[]> {
		return this.tmuxHelpers.listSessions();
	}
}
