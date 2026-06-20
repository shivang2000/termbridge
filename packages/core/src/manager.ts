// SessionManager — the in-process session registry (D8: primitives + registry,
// NOT an orchestrator). `open()` selects an Environment by `opts.env` (only
// "local" in M1), materializes a tmux session, wires a PtyObserver to a
// per-session `pipe-pane -O <tmpfile>`, registers the `oauth-url` recognizer,
// and returns a ready `Session`. Concurrency is capped (subscription-fleet
// caveat) via TERMBRIDGE_MAX_SESSIONS.
//
// Every external is injectable so the whole unit is testable without real tmux,
// fs, or env: pass `envFactory`, `observerFactory`, an `idGen`, and a `maxSessions`.

import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync } from "node:fs";
import { open as openFile, stat as statFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthProvisioner } from "./auth/provisioner.js";
import { DockerEnvironment } from "./env/docker.js";
import { LocalEnvironment } from "./env/local.js";
import { PtyObserver, type ReadAppended } from "./observer/pty-observer.js";
import { claudePermissionRecognizer } from "./recognizers/claude-permission.js";
import { genericYnRecognizer } from "./recognizers/generic-yn.js";
import { oauthUrlRecognizer } from "./recognizers/oauth-url.js";
import { RecognizerPipeline } from "./recognizers/pipeline.js";
import { rateLimitRecognizer } from "./recognizers/rate-limit.js";
import { Session } from "./session/session.js";
import { WriteLock } from "./session/write-lock.js";
import type {
	Environment,
	EnvKind,
	ExecFn,
	OpenSessionOptions,
	SessionInfo,
	SessionState,
} from "./types.js";

const DEFAULT_MAX_SESSIONS = 4;

/** Thrown by `open()` when the concurrency cap is already reached. */
export class ConcurrencyLimitError extends Error {
	readonly code = "concurrency_limit" as const;
	constructor(public readonly limit: number) {
		super(`session limit reached (max ${limit})`);
		this.name = "ConcurrencyLimitError";
	}
}

/** Context handed to the env factory so per-session backends can wire themselves. */
export interface EnvFactoryContext {
	/** Host directory holding this session's `pipe-pane` temp file (Docker bind-mounts it). */
	pipeDir: string;
}

export interface SessionManagerOptions {
	/** Hard cap on concurrent sessions. Defaults to TERMBRIDGE_MAX_SESSIONS or 4. */
	maxSessions?: number;
	/** Build an Environment for a given kind. Defaults to Local/Docker by kind. */
	envFactory?: (kind: EnvKind, ctx: EnvFactoryContext) => Environment;
	/**
	 * Build the per-session PtyObserver, given the `pipe-pane` temp-file path.
	 * Defaults to a real PtyObserver tailing that file.
	 */
	observerFactory?: (pipeFile: string) => PtyObserver;
	/** Deterministic id generator (defaults to a random hex id). */
	idGen?: () => string;
	/** Directory for per-session pipe-pane temp files (defaults to a mkdtemp dir). */
	pipeDir?: string;
	/** Shared ExecFn passed to the default LocalEnvironment (mockable in tests). */
	exec?: ExecFn;
	/** Dedicated tmux socket name for the default LocalEnvironment (safety isolation). */
	socket?: string;
	/**
	 * Persistent credentials volume (becomes each session's HOME) for shared
	 * subscription auth. Defaults to TERMBRIDGE_HOME; when neither is set, sessions
	 * inherit the ambient HOME and no auth provisioning is applied.
	 */
	homeDir?: string;
}

interface Entry {
	session: Session;
	info: SessionInfo;
}

function defaultMaxSessions(): number {
	const raw = process.env.TERMBRIDGE_MAX_SESSIONS;
	if (raw !== undefined) {
		const n = Number.parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) {
			return n;
		}
	}
	return DEFAULT_MAX_SESSIONS;
}

function randomId(): string {
	return Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
}

/**
 * Default directory for per-session `pipe-pane` files. Honours
 * `TERMBRIDGE_PIPE_DIR` (created if missing) so deployments — and the Docker
 * backend, which bind-mounts this dir — can pin it to a path the daemon can
 * share; otherwise a fresh mkdtemp dir.
 */
function resolveDefaultPipeDir(): string {
	const fromEnv = process.env.TERMBRIDGE_PIPE_DIR;
	if (fromEnv) {
		mkdirSync(fromEnv, { recursive: true });
		return fromEnv;
	}
	return mkdtempSync(join(tmpdir(), "termbridge-"));
}

/**
 * A {@link ReadAppended} source over a growing file: each call returns the bytes
 * appended since the previous call. Used to feed the PtyObserver from the
 * `pipe-pane -O <file>` tap. Returns "" (never throws) while the file does not
 * yet exist so the observer poll loop simply idles until tmux creates it.
 */
export function makeFileTailer(path: string): ReadAppended {
	let pos = 0;
	return async () => {
		let size: number;
		try {
			size = (await statFile(path)).size;
		} catch {
			return "";
		}
		if (size <= pos) {
			return "";
		}
		const fh = await openFile(path, "r");
		try {
			const length = size - pos;
			const buf = Buffer.alloc(length);
			const { bytesRead } = await fh.read(buf, 0, length, pos);
			pos += bytesRead;
			return buf.toString("utf8", 0, bytesRead);
		} finally {
			await fh.close();
		}
	};
}

export class SessionManager {
	private readonly maxSessions: number;
	private readonly envFactory: (kind: EnvKind, ctx: EnvFactoryContext) => Environment;
	private readonly observerFactory: (pipeFile: string) => PtyObserver;
	private readonly idGen: () => string;
	private readonly pipeDir: string;
	private readonly auth: AuthProvisioner | undefined;

	private readonly sessions = new Map<string, Entry>();

	constructor(opts: SessionManagerOptions = {}) {
		this.maxSessions = opts.maxSessions ?? defaultMaxSessions();
		const exec = opts.exec;
		const socket = opts.socket;
		this.envFactory =
			opts.envFactory ??
			((kind: EnvKind, ctx: EnvFactoryContext) => {
				if (kind === "local") {
					return new LocalEnvironment({
						...(exec ? { exec } : {}),
						...(socket ? { socket } : {}),
					});
				}
				if (kind === "docker") {
					return new DockerEnvironment({
						pipeDir: ctx.pipeDir,
						...(exec ? { exec } : {}),
						...(socket ? { socket } : {}),
					});
				}
				throw new Error(`unknown environment "${kind}"`);
			});
		this.observerFactory =
			opts.observerFactory ??
			((pipeFile: string) => new PtyObserver({ readAppended: makeFileTailer(pipeFile) }));
		this.idGen = opts.idGen ?? randomId;
		this.pipeDir = opts.pipeDir ?? resolveDefaultPipeDir();
		const homeDir = opts.homeDir ?? process.env.TERMBRIDGE_HOME;
		this.auth = homeDir ? new AuthProvisioner({ homeDir }) : undefined;
		this.auth?.ensureReady();
	}

	/**
	 * Materialize a new session. Throws {@link ConcurrencyLimitError} when the
	 * cap is already reached (caller gets a clean, typed error). Only the "local"
	 * environment is supported in M1; an unknown kind is rejected by the factory.
	 */
	async open(opts: OpenSessionOptions = {}): Promise<Session> {
		if (this.sessions.size >= this.maxSessions) {
			throw new ConcurrencyLimitError(this.maxSessions);
		}

		const kind: EnvKind = opts.env ?? "local";
		// pipeFile lives under pipeDir; Docker bind-mounts pipeDir so the host
		// observer can tail the in-container pipe-pane output.
		const env = this.envFactory(kind, { pipeDir: this.pipeDir });

		const id = this.idGen();
		const name = opts.name ?? `tb-${id}`;
		const cwd = opts.cwd ?? process.cwd();

		let state: SessionState = "running";
		try {
			await env.ensureSession({
				name,
				cwd,
				cmd: opts.cmd,
				cols: opts.cols ?? 500,
				rows: opts.rows ?? 40,
				// Point HOME at the shared credentials volume so claude reads the one
				// subscription login (delivered as tmux -e / docker -e). Undefined when
				// no creds volume is configured → session inherits the ambient HOME.
				env: this.auth?.homeEnv(),
			});
		} catch (err) {
			state = "failed";
			throw err;
		}

		const { session } = await this.buildSession(id, name, kind, env, state);
		return session;
	}

	/**
	 * Wire up the per-session machinery shared by {@link open} and {@link recover}:
	 * tap the pane to a per-session pipe-pane file, build the PtyObserver over that
	 * file, register the recognizer pipeline, create the Session with a fresh
	 * WriteLock, and register the entry. Returns the registered entry.
	 *
	 * Assumes the underlying tmux session already exists (open() creates it via
	 * ensureSession; recover() adopts a pre-existing one).
	 */
	private async buildSession(
		id: string,
		name: string,
		kind: EnvKind,
		env: Environment,
		state: SessionState,
	): Promise<Entry> {
		// Tap the pane to a per-session temp file so the observer's rolling buffer
		// captures output even after it scrolls off the visible pane.
		const pipeFile = join(this.pipeDir, `${name}.log`);
		await env.tmux(["pipe-pane", "-O", "-t", name, `cat >> ${pipeFile}`]);

		const observer = this.observerFactory(pipeFile);
		const pipeline = new RecognizerPipeline();
		pipeline.register(oauthUrlRecognizer);
		pipeline.register(claudePermissionRecognizer);
		pipeline.register(genericYnRecognizer);
		pipeline.register(rateLimitRecognizer);
		observer.start();

		const session = new Session({
			id,
			name,
			env,
			observer,
			pipeline,
			writeLock: new WriteLock(),
		});

		// Surface a needs_login event up-front when the shared creds volume has no
		// login yet — the agent/human then drives `claude auth login` (spec §9).
		if (this.auth && !this.auth.isLoggedIn()) {
			session.queueEvent({
				kind: "needs_login",
				data: { homeDir: this.auth.homeDir },
				suggestedKeys: [],
			});
		}

		const info: SessionInfo = { id, name, env: kind, state };
		const entry: Entry = { session, info };
		this.sessions.set(id, entry);
		return entry;
	}

	/**
	 * Adopt tmux sessions that already exist in the (default-kind) environment but
	 * are not yet tracked by this manager — e.g. survivors of a daemon restart.
	 * Each adopted session is registered via {@link buildSession} (id = name,
	 * state "running") under the concurrency cap. Idempotent: a second call adopts
	 * nothing already tracked. Returns only the newly-adopted SessionInfos.
	 */
	async recover(): Promise<SessionInfo[]> {
		const kind: EnvKind = "local";
		const env = this.envFactory(kind, { pipeDir: this.pipeDir });
		const names = await env.listSessions();

		const adopted: SessionInfo[] = [];
		for (const name of names) {
			if (this.sessions.size >= this.maxSessions) {
				break;
			}
			const id = name;
			if (this.sessions.has(id)) {
				continue;
			}
			const { info } = await this.buildSession(id, name, kind, env, "running");
			adopted.push({ ...info });
		}
		return adopted;
	}

	/** Look up a live session by id, or undefined if absent/closed. */
	get(id: string): Session | undefined {
		return this.sessions.get(id)?.session;
	}

	/** Snapshot of every registered session's info. */
	list(): SessionInfo[] {
		return [...this.sessions.values()].map((e) => ({ ...e.info }));
	}

	/**
	 * Close and deregister a session. Idempotent — closing an unknown id is a
	 * no-op. Frees a concurrency slot.
	 */
	async close(id: string): Promise<void> {
		const entry = this.sessions.get(id);
		if (!entry) {
			return;
		}
		this.sessions.delete(id);
		await entry.session.close();
	}
}
