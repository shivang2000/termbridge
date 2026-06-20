// DockerEnvironment — runs tmux INSIDE a per-session Docker container via the
// `docker` CLI, behind the same `Environment` interface as LocalEnvironment
// (D4 "Docker-per-session"). One instance == one container == one session: the
// container is created on `ensureSession` and every later tmux call is routed
// through `docker exec`. The agent layer NEVER attaches — it only issues tmux
// CLI commands through `tmux()` (D1). Every method delegates to an injectable
// `ExecFn`, so this whole unit is testable with a mock and never spawns a real
// docker or tmux.

import { defaultExec } from "../tmux/helpers.js";
import type { EnsureSessionOptions, Environment, ExecFn, ExecResult, TermSize } from "../types.js";

export interface DockerEnvironmentOptions {
	/**
	 * Injectable command runner. Defaults to the real `execFile`-backed exec.
	 * Unlike LocalEnvironment, no `withTmuxSocket` wrapper is applied: tmux runs
	 * INSIDE the container (via `docker exec`), so isolation comes from the
	 * container boundary plus the `-L <socket>` server name passed explicitly.
	 */
	exec?: ExecFn;
	/** Container image to run. Defaults to `"termbridge:dev"`. */
	image?: string;
	/**
	 * Dedicated tmux socket name (`-L <socket>`) used inside the container.
	 * Defaults to `TERMBRIDGE_TMUX_SOCKET` or `"termbridge"`.
	 */
	socket?: string;
	/** Prefix for the per-session container name. Defaults to `"termbridge-"`. */
	containerPrefix?: string;
	/**
	 * Host directory to bind-mount into the container (so the PTY observer's pipe
	 * file is reachable from the host). When undefined, no extra mount is added.
	 */
	pipeDir?: string;
}

export class DockerEnvironment implements Environment {
	readonly kind = "docker" as const;

	private readonly exec: ExecFn;
	private readonly image: string;
	private readonly socket: string;
	private readonly containerPrefix: string;
	private readonly pipeDir: string | undefined;

	/** Set on `ensureSession`; identifies the one container this instance owns. */
	private container: string | undefined;

	constructor(opts: DockerEnvironmentOptions = {}) {
		this.exec = opts.exec ?? defaultExec;
		this.image = opts.image ?? "termbridge:dev";
		this.socket = opts.socket ?? process.env.TERMBRIDGE_TMUX_SOCKET ?? "termbridge";
		this.containerPrefix = opts.containerPrefix ?? "termbridge-";
		this.pipeDir = opts.pipeDir;
	}

	async ensureSession(opts: EnsureSessionOptions): Promise<void> {
		const container = `${this.containerPrefix}${opts.name}`;

		const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

		// 1) Start the long-lived container (`tail -f /dev/null` keeps it alive so
		//    we can `docker exec` tmux into it on subsequent calls).
		const run = await this.exec("docker", [
			"run",
			"-d",
			"--name",
			container,
			"-v",
			`${opts.cwd}:${opts.cwd}`,
			...(this.pipeDir ? ["-v", `${this.pipeDir}:${this.pipeDir}`] : []),
			"-w",
			opts.cwd,
			...envFlags,
			this.image,
			"tail",
			"-f",
			"/dev/null",
		]);
		if (run.code !== 0) {
			throw new Error("docker run failed: " + run.stderr);
		}

		// 2) Create the detached tmux session inside the container.
		const newSession = await this.exec("docker", [
			"exec",
			container,
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
			// Best-effort cleanup so a failed start doesn't leak a container. This
			// must NEVER mask the root-cause error below, so swallow any rejection
			// from the teardown exec (e.g. docker daemon dropping mid-cleanup).
			try {
				await this.exec("docker", ["rm", "-f", container]);
			} catch {
				// Swallow: cleanup is best-effort; the new-session failure is what matters.
			}
			throw new Error("tmux new-session failed: " + newSession.stderr);
		}

		this.container = container;
	}

	/**
	 * Raw tmux passthrough, wrapped in `docker exec` against this instance's
	 * container and pinned to `-L <socket>`. Returns the `ExecResult` verbatim
	 * (never rejects on non-zero exit) so callers can branch on `code`.
	 */
	async tmux(args: string[]): Promise<ExecResult> {
		if (this.container === undefined) {
			throw new Error("DockerEnvironment.tmux called before ensureSession");
		}
		return this.exec("docker", ["exec", this.container, "tmux", "-L", this.socket, ...args]);
	}

	/** Declared in M1, implemented in M5 (node-pty running `tmux attach`). */
	attachPty(_name: string, _size: TermSize): unknown {
		throw new Error("attachPty is implemented in M5");
	}

	async destroySession(name: string): Promise<void> {
		const container = `${this.containerPrefix}${name}`;
		try {
			// Ignore non-zero (container already gone) — destroy must never throw.
			await this.exec("docker", ["rm", "-f", container]);
		} catch {
			// Swallow: tearing down a session must be best-effort.
		}
	}

	async listSessions(): Promise<string[]> {
		if (this.container === undefined) {
			throw new Error("DockerEnvironment.listSessions called before ensureSession");
		}
		const res = await this.exec("docker", [
			"exec",
			this.container,
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
