// SandboxEnvironment — runs tmux INSIDE a cloud sandbox (E2B/Daytona/…) behind
// the same `Environment` interface as LocalEnvironment (M1) and DockerEnvironment
// (M2), so an orchestrator can pick "local" | "docker" | "sandbox" with no other
// code change (D4 "cloud sandbox later via the same interface"). One instance ==
// one sandbox == one session. Cloud specifics live behind a pluggable
// `SandboxProvider`: this class never imports an SDK, it only issues tmux CLI
// commands through `provider.exec` (D1 — the agent NEVER attaches). That keeps the
// unit testable with a recording mock and core a zero-runtime-dependency package.

import type { EnsureSessionOptions, Environment, ExecResult, TermSize } from "../types.js";

/**
 * Pluggable cloud backend. A provider owns the lifecycle of exactly one sandbox:
 * `ensure` provisions/boots it, `exec` runs an argv inside it (returning the
 * `ExecResult` verbatim, never rejecting on non-zero), and `destroy` tears it
 * down. Any cloud (E2B, Daytona, Cloudflare, …) can implement this so the same
 * `SandboxEnvironment` works over all of them.
 */
export interface SandboxProvider {
	readonly name: string;
	ensure(opts: {
		name: string;
		cwd: string;
		image?: string;
		env?: Record<string, string>;
	}): Promise<void>;
	exec(args: string[]): Promise<ExecResult>;
	destroy(): Promise<void>;
}

export interface SandboxEnvironmentOptions {
	/** The cloud backend this environment drives. Required. */
	provider: SandboxProvider;
	/**
	 * Dedicated tmux socket name (`-L <socket>`) used inside the sandbox.
	 * Defaults to `TERMBRIDGE_TMUX_SOCKET` or `"termbridge"`.
	 */
	socket?: string;
}

export class SandboxEnvironment implements Environment {
	readonly kind = "sandbox" as const;

	private readonly provider: SandboxProvider;
	private readonly socket: string;

	constructor(opts: SandboxEnvironmentOptions) {
		this.provider = opts.provider;
		this.socket = opts.socket ?? process.env.TERMBRIDGE_TMUX_SOCKET ?? "termbridge";
	}

	async ensureSession(opts: EnsureSessionOptions): Promise<void> {
		// 1) Provision/boot the sandbox via the provider. `env` carries the
		//    subscription HOME etc.; the provider decides how to apply it.
		await this.provider.ensure({ name: opts.name, cwd: opts.cwd, env: opts.env });

		// 2) Create the detached tmux session inside the sandbox, pinned to our
		//    dedicated `-L <socket>` server.
		const newSession = await this.provider.exec([
			"tmux",
			"-L",
			this.socket,
			"new-session",
			"-d",
			"-s",
			opts.name,
			"-x",
			String(opts.cols),
			"-y",
			String(opts.rows),
			"-c",
			opts.cwd,
			...(opts.cmd ? [opts.cmd] : []),
		]);
		if (newSession.code !== 0) {
			// Provider.ensure already booted a cloud sandbox — tear it down so a
			// failed open cannot leave an orphaned billed sandbox.
			try {
				await this.provider.destroy();
			} catch {
				/* destroy must never throw */
			}
			throw new Error(`tmux new-session failed: ${newSession.stderr}`);
		}
	}

	/**
	 * Raw tmux passthrough, routed through `provider.exec` and pinned to
	 * `-L <socket>`. Returns the `ExecResult` verbatim (never rejects on non-zero
	 * exit) so callers can branch on `code`.
	 */
	async tmux(args: string[]): Promise<ExecResult> {
		return this.provider.exec(["tmux", "-L", this.socket, ...args]);
	}

	/** Declared in M1, implemented in M5 (node-pty bridged over the provider). */
	attachPty(_name: string, _size: TermSize): unknown {
		throw new Error("attachPty: web/M5 only");
	}

	async destroySession(_name: string): Promise<void> {
		try {
			// Ignore errors — tearing down a sandbox must be best-effort.
			await this.provider.destroy();
		} catch {
			// Swallow: destroy must never throw.
		}
	}

	async listSessions(): Promise<string[]> {
		const res = await this.provider.exec([
			"tmux",
			"-L",
			this.socket,
			"list-sessions",
			"-F",
			"#{session_name}",
		]);
		// Non-zero == "no server running" / no sessions: normal empty state.
		if (res.code !== 0) return [];
		return res.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}
}
