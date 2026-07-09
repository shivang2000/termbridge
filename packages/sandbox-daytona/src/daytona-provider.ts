// DaytonaSandboxProvider — SandboxProvider for Daytona workspaces.
// SDK calls are behind an injectable DaytonaClient so unit tests never hit cloud (D3).
import type { ExecResult, SandboxProvider } from "@termbridge/core";

/** Minimal client surface required by the provider (map your Daytona SDK here). */
export interface DaytonaClient {
	create(opts: {
		name: string;
		cwd: string;
		image?: string;
		env?: Record<string, string>;
	}): Promise<{ id: string }>;
	exec(id: string, cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	destroy(id: string): Promise<void>;
}

export interface DaytonaSandboxProviderOptions {
	/** Injectable client (required for real use; tests pass a recording mock). */
	client: DaytonaClient;
	/** Optional image / snapshot id. */
	image?: string;
}

function shellQuote(arg: string): string {
	if (arg.length === 0) return "''";
	if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class DaytonaSandboxProvider implements SandboxProvider {
	readonly name = "daytona";
	private readonly client: DaytonaClient;
	private readonly image: string | undefined;
	private workspaceId: string | undefined;

	constructor(opts: DaytonaSandboxProviderOptions) {
		this.client = opts.client;
		this.image = opts.image;
	}

	async ensure(opts: {
		name: string;
		cwd: string;
		image?: string;
		env?: Record<string, string>;
	}): Promise<void> {
		await this.destroy();
		const ws = await this.client.create({
			name: opts.name,
			cwd: opts.cwd,
			image: opts.image ?? this.image,
			env: opts.env,
		});
		this.workspaceId = ws.id;
		try {
			// Single command: install if needed, then require tmux on PATH.
			const probe = await this.execRaw(
				"command -v tmux >/dev/null 2>&1 || (sudo -n apt-get update -y && sudo -n apt-get install -y tmux); command -v tmux",
			);
			if (probe.code !== 0) {
				throw new Error(
					`DaytonaSandboxProvider: tmux missing after install (exit ${probe.code}): ${probe.stderr || probe.stdout}`,
				);
			}
		} catch (err) {
			await this.destroy();
			throw err;
		}
	}

	async exec(args: string[]): Promise<ExecResult> {
		return this.execRaw(args.map(shellQuote).join(" "));
	}

	private async execRaw(cmd: string): Promise<ExecResult> {
		if (!this.workspaceId) {
			throw new Error("DaytonaSandboxProvider.exec called before ensure");
		}
		const r = await this.client.exec(this.workspaceId, cmd);
		return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
	}

	async destroy(): Promise<void> {
		const id = this.workspaceId;
		this.workspaceId = undefined;
		if (!id) return;
		try {
			await this.client.destroy(id);
		} catch {
			/* destroy must never throw */
		}
	}

	get id(): string | undefined {
		return this.workspaceId;
	}
}
