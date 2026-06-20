// Thin, injectable wrapper around the tmux CLI.
//
// Every method routes through the injected `ExecFn` so unit tests can assert the
// exact argv with a mock and never spawn a real tmux (D1 / spec §10.1). The agent
// layer only ever issues these CLI commands — it NEVER attaches to the session.

import { execFile } from "node:child_process";
import type { ExecFn, ExecResult } from "../types.js";

export interface NewSessionOptions {
	name: string;
	cwd: string;
	cmd?: string;
	/** Default 500 — intentionally wide so OAuth URLs never hard-wrap (spec §7). */
	cols?: number;
	rows?: number;
	env?: Record<string, string>;
}

export interface SendKeysOptions {
	/** Pass true to send raw text (`-l`); false (default) for named keys like "Enter". */
	literal?: boolean;
}

export interface CapturePaneOptions {
	/** Lines of scrollback to include above the visible screen. */
	scrollback?: number;
}

/**
 * tmux CLI helpers bound to one `ExecFn`. Construct with the default exec for
 * real use, or a mock in tests.
 */
export class TmuxHelpers {
	constructor(private readonly exec: ExecFn) {}

	async newSession(opts: NewSessionOptions): Promise<ExecResult> {
		const { name, cwd, cmd, cols = 500, rows = 40, env } = opts;
		// Pass env as tmux per-session `-e KEY=VALUE` (NOT the client's process
		// env): tmux's update-environment does not carry HOME, so client env would
		// not reach the session's panes. `-e` sets the session environment that the
		// pane shell inherits — this is how AuthProvisioner delivers HOME (M4).
		const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
		const args = [
			"new-session",
			"-d",
			"-s",
			name,
			"-x",
			String(cols),
			"-y",
			String(rows),
			"-c",
			cwd,
			...envFlags,
			...(cmd ? [cmd] : []),
		];
		return this.exec("tmux", args);
	}

	async sendKeys(name: string, keys: string, opts: SendKeysOptions = {}): Promise<ExecResult> {
		const { literal = false } = opts;
		const args = ["send-keys", "-t", name, ...(literal ? ["-l"] : []), keys];
		return this.exec("tmux", args);
	}

	async sendControl(name: string, key: string): Promise<ExecResult> {
		return this.exec("tmux", ["send-keys", "-t", name, key]);
	}

	async capturePane(name: string, opts: CapturePaneOptions = {}): Promise<string> {
		const { scrollback } = opts;
		const args = [
			"capture-pane",
			"-p",
			"-t",
			name,
			...(scrollback !== undefined ? ["-S", `-${scrollback}`] : []),
		];
		const res = await this.exec("tmux", args);
		return res.stdout;
	}

	async pipePaneStart(name: string, file: string): Promise<ExecResult> {
		return this.exec("tmux", ["pipe-pane", "-O", "-t", name, `cat >> ${file}`]);
	}

	async hasSession(name: string): Promise<boolean> {
		const res = await this.exec("tmux", ["has-session", "-t", name]);
		return res.code === 0;
	}

	async killSession(name: string): Promise<ExecResult> {
		return this.exec("tmux", ["kill-session", "-t", name]);
	}

	async listSessions(): Promise<string[]> {
		const res = await this.exec("tmux", ["list-sessions", "-F", "#{session_name}"]);
		// `tmux list-sessions` exits non-zero with "no server running" when there
		// are no sessions — that's a normal empty state, never an error here.
		if (res.code !== 0) return [];
		return res.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}

	async resizeWindow(name: string, cols: number, rows: number): Promise<ExecResult> {
		return this.exec("tmux", ["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
	}
}

/**
 * Default `ExecFn` backed by `node:child_process.execFile`. Used in production
 * wiring only — tests inject a mock and never touch this. Resolves to an
 * `ExecResult` even on non-zero exit (so callers like `hasSession`/`listSessions`
 * can branch on `code` instead of catching).
 */
export const defaultExec: ExecFn = (file, args, opts) =>
	new Promise<ExecResult>((resolve) => {
		execFile(
			file,
			args,
			{ env: opts?.env, cwd: opts?.cwd, encoding: "utf8" },
			(err, stdout, stderr) => {
				const code =
					err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
						? ((err as unknown as { code: number }).code as number)
						: err
							? 1
							: 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			},
		);
	});

/**
 * Default name for termbridge's dedicated tmux socket. A `-L <name>` socket is a
 * *separate tmux server* — distinct from the user's default server.
 */
export const DEFAULT_TMUX_SOCKET = "termbridge";

/**
 * CRITICAL SAFETY: wrap an `ExecFn` so every `tmux` invocation is pinned to a
 * dedicated `-L <socket>` server. Without this, termbridge shares the user's
 * default tmux server and could observe — or kill — the user's own sessions.
 * Non-tmux calls pass through unchanged. Applied to the real `defaultExec` on the
 * production path; mock execs in tests are left alone so they assert plain argv.
 */
export function withTmuxSocket(base: ExecFn, socket: string = DEFAULT_TMUX_SOCKET): ExecFn {
	return (file, args, opts) =>
		file === "tmux" ? base(file, ["-L", socket, ...args], opts) : base(file, args, opts);
}
