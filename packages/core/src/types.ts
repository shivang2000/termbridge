// Shared, framework-agnostic contracts for @termbridge/core.
//
// Committed in the scaffold so every unit (built in parallel) compiles against a
// stable interface. Nothing here imports MCP, HTTP, or any backend — core stays
// framework-agnostic (D3).

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

/** Result of running a child process (tmux, docker, …). */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Injectable command runner. tmux helpers take one so unit tests can mock the
 * child process instead of shelling out to a real tmux (spec §10.1).
 */
export type ExecFn = (
	file: string,
	args: string[],
	opts?: { env?: Record<string, string>; cwd?: string },
) => Promise<ExecResult>;

/** A monotonic millisecond clock, injectable for deterministic time tests. */
export type Clock = () => number;

// ---------------------------------------------------------------------------
// Environment (pluggable backend — D4)
// ---------------------------------------------------------------------------

export type EnvKind = "local" | "docker";

/** Terminal size in character cells. */
export interface TermSize {
	cols: number;
	rows: number;
}

/** Options for materializing the underlying tmux session inside an Environment. */
export interface EnsureSessionOptions {
	name: string;
	cwd: string;
	cmd?: string;
	cols: number;
	rows: number;
	env?: Record<string, string>;
}

/**
 * Pluggable execution backend. `LocalEnvironment` (M1) runs tmux on the host;
 * `DockerEnvironment` (M2) runs it via `docker exec`; a cloud sandbox follows
 * later (M6) behind the same interface. The agent layer NEVER attaches — it only
 * issues tmux CLI commands through `tmux()`.
 */
export interface Environment {
	readonly kind: EnvKind;
	ensureSession(opts: EnsureSessionOptions): Promise<void>;
	tmux(args: string[]): Promise<ExecResult>;
	/** Declared in M1, implemented in M5 (node-pty running `tmux attach`). */
	attachPty?(name: string, size: TermSize): unknown;
	destroySession(name: string): Promise<void>;
	listSessions(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Recognizers (pluggable prompt detection — D7)
// ---------------------------------------------------------------------------

/** A structured interactive state detected on the screen. */
export interface RecognizedEvent {
	kind: string;
	data: Record<string, unknown>;
	/** Keys an agent could send to respond, e.g. ["y"], ["Enter"]. */
	suggestedKeys: string[];
}

/** A pluggable detector. Returns the event payload (without `kind`) or null. */
export interface Recognizer {
	readonly kind: string;
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null;
}

// ---------------------------------------------------------------------------
// WriteLock (human/agent arbitration)
// ---------------------------------------------------------------------------

export type WriteLockState = "agent" | "human-active";

export interface AgentWriteResult {
	ok: boolean;
	/** Set when `ok` is false because a human is currently driving. */
	error?: "human_driving";
}

// ---------------------------------------------------------------------------
// Session-facing result shapes (mirror MCP tool returns — spec §6)
// ---------------------------------------------------------------------------

export interface SendOptions {
	enter?: boolean;
}

export interface SendResult {
	ok: boolean;
	error?: "human_driving";
}

export interface ReadScreenOptions {
	/** Lines of scrollback to include above the visible screen. */
	scrollback?: number;
}

export interface ReadOutputResult {
	data: string;
	nextOffset: number;
}

export interface IdleResult {
	idle: boolean;
	waitedMs: number;
}

export interface WaitTextResult {
	matched: boolean;
	screen: string;
}

export interface EventsResult {
	events: RecognizedEvent[];
	nextOffset: number;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

export type SessionState = "running" | "failed" | "closed";

export interface SessionInfo {
	id: string;
	name: string;
	env: EnvKind;
	state: SessionState;
}

export interface OpenSessionOptions {
	name?: string;
	env?: EnvKind;
	cwd?: string;
	repo?: string;
	branch?: string;
	cmd?: string;
	cols?: number;
	rows?: number;
}
