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
import { claudeActivityRecognizer } from "./recognizers/claude-activity.js";
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

/**
 * Thrown by `open()` when the explicitly-requested environment is outside the
 * configured allowlist (see {@link SessionManagerOptions.allowedEnvs}). Lets a
 * caller lock an untrusted control plane — e.g. a chat-gateway agent — to
 * container isolation so a session can never execute on the host.
 */
export class EnvNotAllowedError extends Error {
	readonly code = "env_not_allowed" as const;
	constructor(
		public readonly env: EnvKind,
		public readonly allowed: readonly EnvKind[],
	) {
		super(`environment "${env}" is not permitted (allowed: ${allowed.join(", ")})`);
		this.name = "EnvNotAllowedError";
	}
}

/** Every environment kind, used to validate TERMBRIDGE_ALLOWED_ENVS tokens. */
const ALL_ENV_KINDS: readonly EnvKind[] = ["local", "docker", "sandbox"];

/**
 * Parse a comma-separated TERMBRIDGE_ALLOWED_ENVS value into a validated env
 * allowlist. Unknown tokens are dropped; an empty/all-invalid result yields
 * `undefined` (no policy) rather than an empty allowlist that would deny every
 * open — an empty allowlist is treated as "not configured", not "deny all".
 */
function parseAllowedEnvs(raw: string | undefined): EnvKind[] | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const tokens = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	// Truly empty (unset / whitespace / commas only) → no policy.
	if (tokens.length === 0) {
		return undefined;
	}
	// FAIL LOUD on typos / wrong delimiters (e.g. "docker;local", "container").
	// Silently dropping unknown tokens would degrade a misconfigured lockdown to
	// "no policy" while the operator believes the env is locked — a security trap.
	const invalid = tokens.filter((s) => !(ALL_ENV_KINDS as readonly string[]).includes(s));
	if (invalid.length > 0) {
		throw new Error(
			`TERMBRIDGE_ALLOWED_ENVS contains invalid values: ${invalid.join(", ")}. ` +
				`Valid (comma-separated): ${ALL_ENV_KINDS.join(", ")}`,
		);
	}
	return tokens as EnvKind[];
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
	/**
	 * Allowlist of environments `open()` will permit. When set (non-empty), an
	 * explicitly-requested env outside the list is rejected with
	 * {@link EnvNotAllowedError}, and an OMITTED env is coerced to {@link defaultEnv}
	 * (which is pinned to an allowed value). Defaults to TERMBRIDGE_ALLOWED_ENVS
	 * (comma-separated) or undefined (all envs allowed). Set to `["docker"]` to lock
	 * an untrusted caller to container isolation — a session can then never run on
	 * the host, even if the caller asks for `env:"local"`.
	 */
	allowedEnvs?: EnvKind[];
	/**
	 * Environment used when a caller omits `env`. Defaults to "local"; if that is
	 * not in {@link allowedEnvs}, the first allowed env is used instead.
	 */
	defaultEnv?: EnvKind;
	/**
	 * Allowlist of host env-var NAMES to forward into each session's environment
	 * (merged with HOME). Lets a session's `gh`/git authenticate for in-session
	 * push + PR. Defaults to TERMBRIDGE_FORWARD_ENV (comma-separated) and ALWAYS
	 * includes `GH_TOKEN` + `GH_HOST` when they are set in the host process.
	 * Allowlist only — arbitrary host env is never leaked into a session.
	 */
	forwardEnv?: string[];
	/**
	 * Default for in-session auto-approve when `open()` doesn't pass `autoApprove`.
	 * Falls back to `TERMBRIDGE_AUTO_APPROVE` (1/true/yes/on). Default off.
	 */
	autoApprove?: boolean;
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
	/** Permitted environments; undefined = no policy (all allowed). */
	private readonly allowedEnvs: readonly EnvKind[] | undefined;
	/** Environment used when `open()` is called without an explicit `env`. */
	private readonly defaultEnv: EnvKind;
	/** Host env-var names forwarded into each session (allowlist; incl. GH_TOKEN/GH_HOST). */
	private readonly forwardEnv: readonly string[];
	/** Default for per-session auto-approve when `open()` doesn't specify (TERMBRIDGE_AUTO_APPROVE). */
	private readonly autoApproveDefault: boolean;

	private readonly sessions = new Map<string, Entry>();
	/**
	 * Slots reserved synchronously by in-flight `open()` calls that have passed the
	 * cap check but not yet registered their Session. Counting these alongside
	 * `sessions.size` closes the TOCTOU race where concurrent `open()` calls all
	 * clear the cap before any of them registers, letting the limit be exceeded.
	 */
	private reserved = 0;

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

		// Env policy: an explicit option wins; otherwise read TERMBRIDGE_ALLOWED_ENVS.
		// An empty option array is treated as "not configured" (no deny-all footgun).
		const optAllowed =
			opts.allowedEnvs && opts.allowedEnvs.length > 0 ? opts.allowedEnvs : undefined;
		const allowedEnvs = optAllowed ?? parseAllowedEnvs(process.env.TERMBRIDGE_ALLOWED_ENVS);
		this.allowedEnvs = allowedEnvs;
		// Pin the omitted-env default to an allowed value so callers that don't pass
		// `env` succeed under a policy instead of always tripping the guard.
		let defaultEnv: EnvKind = opts.defaultEnv ?? "local";
		if (allowedEnvs && !allowedEnvs.includes(defaultEnv)) {
			const first = allowedEnvs[0];
			if (first) {
				defaultEnv = first;
			}
		}
		this.defaultEnv = defaultEnv;

		// Host env-var names to forward into sessions (allowlist). Explicit option or
		// TERMBRIDGE_FORWARD_ENV (csv), plus GH_TOKEN/GH_HOST always so in-session
		// `gh` can push + open a PR. De-duplicated.
		const fromEnv = (process.env.TERMBRIDGE_FORWARD_ENV ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		this.forwardEnv = [...new Set([...(opts.forwardEnv ?? fromEnv), "GH_TOKEN", "GH_HOST"])];

		// In-session auto-approve default: explicit option wins, else TERMBRIDGE_AUTO_APPROVE.
		this.autoApproveDefault =
			opts.autoApprove ?? /^(1|true|yes|on)$/i.test(process.env.TERMBRIDGE_AUTO_APPROVE ?? "");
	}

	/**
	 * The env merged into a new session: the shared-creds HOME plus any allowlisted
	 * host vars (e.g. GH_TOKEN) that are actually set. Returns undefined when empty
	 * so the session simply inherits the ambient environment.
	 */
	private sessionEnv(): Record<string, string> | undefined {
		const env: Record<string, string> = { ...(this.auth?.homeEnv() ?? {}) };
		for (const name of this.forwardEnv) {
			const value = process.env[name];
			if (value !== undefined && value !== "") {
				env[name] = value;
			}
		}
		return Object.keys(env).length > 0 ? env : undefined;
	}

	/**
	 * Materialize a new session. Throws {@link ConcurrencyLimitError} when the
	 * cap is already reached (caller gets a clean, typed error). Only the "local"
	 * environment is supported in M1; an unknown kind is rejected by the factory.
	 */
	async open(opts: OpenSessionOptions = {}): Promise<Session> {
		// Resolve + validate the execution backend FIRST. Under an env policy
		// (allowedEnvs / TERMBRIDGE_ALLOWED_ENVS) an explicitly-requested env outside
		// the allowlist is rejected with a typed error BEFORE any slot is reserved or
		// container spawned; an omitted env is coerced to the (allowed) default. This
		// is what lets an untrusted caller be pinned to docker-only so a session can
		// never execute on the host.
		const kind: EnvKind = opts.env ?? this.defaultEnv;
		if (this.allowedEnvs && !this.allowedEnvs.includes(kind)) {
			throw new EnvNotAllowedError(kind, this.allowedEnvs);
		}

		// Reserve a slot SYNCHRONOUSLY (before the first await) so concurrent
		// open() calls cannot all clear the cap and then exceed it. `reserved`
		// counts in-flight opens; on success we register the Session, and we
		// ALWAYS release the reservation in finally (a failed open frees its slot).
		if (this.sessions.size + this.reserved >= this.maxSessions) {
			throw new ConcurrencyLimitError(this.maxSessions);
		}
		this.reserved++;

		try {
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
					// HOME → the shared credentials volume (claude reads the one
					// subscription login) PLUS allowlisted forwarded vars (e.g. GH_TOKEN
					// for in-session push/PR), delivered as tmux -e / docker -e. Undefined
					// when nothing is configured → session inherits the ambient env.
					env: this.sessionEnv(),
				});
			} catch (err) {
				state = "failed";
				throw err;
			}

			const { session } = await this.buildSession(
				id,
				name,
				kind,
				env,
				state,
				opts.autoApprove ?? this.autoApproveDefault,
			);
			return session;
		} finally {
			this.reserved--;
		}
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
		autoApprove: boolean,
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
		pipeline.register(claudeActivityRecognizer);
		observer.start();

		const session = new Session({
			id,
			name,
			env,
			observer,
			pipeline,
			writeLock: new WriteLock(),
			autoApprove,
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
		// Adopt under the policy-compliant default — NOT a hardcoded "local". Under a
		// docker-only policy this prevents recover() from silently re-adopting host
		// tmux sessions (which would bypass the open() guard). With no policy the
		// default stays "local", so behaviour is unchanged.
		const kind: EnvKind = this.defaultEnv;
		if (this.allowedEnvs && !this.allowedEnvs.includes(kind)) {
			return [];
		}
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
			const { info } = await this.buildSession(
				id,
				name,
				kind,
				env,
				"running",
				this.autoApproveDefault,
			);
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
