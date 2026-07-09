// E2BSandboxProvider — a concrete SandboxProvider backed by the E2B cloud sandbox
// SDK. One instance provisions/execs/destroys exactly one E2B sandbox (one sandbox
// == one termbridge session). Every SDK call is behind an injectable
// `sandboxFactory` so the unit is tested with a recording mock and never touches a
// real cloud (D3: this package owns the SDK; @termbridge/core stays dependency-free).
//
// exec() maps an argv to the SDK's commands.run, which takes a SHELL COMMAND STRING
// (not an argv) — so each arg is shell-quoted. The SDK throws CommandExitError on
// non-zero exit; we catch it and return {stdout, stderr, code} verbatim so exec
// NEVER rejects on non-zero (the ExecFn contract DockerEnvironment + tmux helpers
// honour). Genuine SDK errors (network/auth) propagate.

import type { ExecResult, SandboxProvider } from "@termbridge/core";
import { Sandbox } from "e2b";

interface SandboxCreateOpts {
	template?: string;
	envs?: Record<string, string>;
	apiKey?: string;
	timeoutMs?: number;
	metadata?: Record<string, string>;
}

interface E2BSandboxLike {
	readonly sandboxId: string;
	commands: {
		run(
			cmd: string,
			opts?: { timeoutMs?: number },
		): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }>;
	};
	kill(): Promise<boolean>;
}

export interface E2BSandboxProviderOptions {
	/** E2B API key. Defaults to E2B_API_KEY env. Required for a real cloud call. */
	apiKey?: string;
	/** E2B sandbox template (must permit tmux). Defaults to "base". */
	template?: string;
	/** Sandbox lifetime in ms. Defaults to 3_600_000 (1h). */
	timeoutMs?: number;
	/** Injectable sandbox factory (for tests). Defaults to the real E2B Sandbox.create. */
	sandboxFactory?: (opts: SandboxCreateOpts) => Promise<E2BSandboxLike>;
}

const DEFAULT_TIMEOUT_MS = 3_600_000;

/** Shell-quote a single argv token (single-quote wrap if it has spaces/metachars). */
function shellQuote(arg: string): string {
	if (arg.length === 0) return "''";
	if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class E2BSandboxProvider implements SandboxProvider {
	readonly name = "e2b";

	private readonly apiKey: string | undefined;
	private readonly template: string;
	private readonly timeoutMs: number;
	private readonly sandboxFactory: (opts: SandboxCreateOpts) => Promise<E2BSandboxLike>;
	private sandbox: E2BSandboxLike | undefined;

	constructor(opts: E2BSandboxProviderOptions = {}) {
		this.apiKey = opts.apiKey ?? process.env.E2B_API_KEY;
		this.template = opts.template ?? "base";
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.sandboxFactory =
			opts.sandboxFactory ??
			((o: SandboxCreateOpts) => Sandbox.create(o) as unknown as Promise<E2BSandboxLike>);
	}

	async ensure(opts: {
		name: string;
		cwd: string;
		image?: string;
		env?: Record<string, string>;
	}): Promise<void> {
		// Tear down any previous sandbox this instance owned (one instance == one sandbox).
		await this.destroy();
		this.sandbox = await this.sandboxFactory({
			...(opts.image ? { template: opts.image } : { template: this.template }),
			envs: opts.env,
			apiKey: this.apiKey,
			timeoutMs: this.timeoutMs,
			metadata: { name: opts.name },
		});
		try {
			// The E2B `base` template does NOT ship tmux, and the default user is
			// non-root (uid 1000, in the sudo group). Install with passwordless sudo
			// so SandboxEnvironment.ensureSession can run tmux new-session.
			const install = await this.execRaw(
				"command -v tmux >/dev/null 2>&1 || (sudo -n apt-get update -y && sudo -n apt-get install -y tmux)",
			);
			if (install.code !== 0) {
				throw new Error(
					`E2BSandboxProvider: failed to install tmux (exit ${install.code}): ${install.stderr || install.stdout}`,
				);
			}
			const probe = await this.execRaw("command -v tmux");
			if (probe.code !== 0) {
				throw new Error("E2BSandboxProvider: tmux still missing after install");
			}
		} catch (err) {
			// Cloud sandbox is already billed/running — always kill on setup failure
			// so a failed smoke/open cannot leave orphans on the E2B dashboard.
			await this.destroy();
			throw err;
		}
	}

	async exec(args: string[]): Promise<ExecResult> {
		return this.execRaw(args.map(shellQuote).join(" "));
	}

	/** Run a raw shell command string; map CommandExitError → non-zero result. */
	private async execRaw(cmd: string): Promise<ExecResult> {
		if (!this.sandbox) {
			throw new Error("E2BSandboxProvider.exec called before ensure");
		}
		try {
			const r = await this.sandbox.commands.run(cmd, { timeoutMs: this.timeoutMs });
			return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
		} catch (err) {
			const e = err as { exitCode?: number; stdout?: string; stderr?: string };
			if (typeof e.exitCode === "number") {
				return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.exitCode };
			}
			throw err;
		}
	}

	async destroy(): Promise<void> {
		const sb = this.sandbox;
		this.sandbox = undefined;
		if (!sb) return;
		const id = sb.sandboxId;
		// Prefer instance kill, then static Sandbox.kill as a belt-and-suspenders
		// path so a hung instance handle cannot leave a dashboard orphan.
		try {
			await sb.kill();
		} catch {
			/* try static kill below */
		}
		if (id) {
			try {
				await Sandbox.kill(id, this.apiKey ? { apiKey: this.apiKey } : undefined);
			} catch {
				// Swallow: destroy must never throw (mirrors SandboxEnvironment.destroySession).
			}
		}
	}

	/** Cloud sandbox id if one is currently provisioned (for smoke/logging). */
	get sandboxId(): string | undefined {
		return this.sandbox?.sandboxId;
	}
}
