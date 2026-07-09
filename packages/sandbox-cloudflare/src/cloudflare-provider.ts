// CloudflareSandboxProvider — SandboxProvider for Cloudflare Workers sandboxes /
// containers. SDK calls are behind an injectable CloudflareSandboxClient so unit
// tests never hit the edge network (D3).
import type { ExecResult, SandboxProvider } from "@termbridge/core";

/** Minimal client surface required by the provider (map your CF sandbox SDK here). */
export interface CloudflareSandboxClient {
	create(opts: {
		name: string;
		cwd: string;
		image?: string;
		env?: Record<string, string>;
	}): Promise<{ id: string }>;
	exec(id: string, cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	destroy(id: string): Promise<void>;
}

export interface CloudflareSandboxProviderOptions {
	/** Injectable client (required for real use; tests pass a recording mock). */
	client: CloudflareSandboxClient;
	/** Optional container image / binding id. */
	image?: string;
}

function shellQuote(arg: string): string {
	if (arg.length === 0) return "''";
	if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class CloudflareSandboxProvider implements SandboxProvider {
	readonly name = "cloudflare";
	private readonly client: CloudflareSandboxClient;
	private readonly image: string | undefined;
	private sandboxId: string | undefined;

	constructor(opts: CloudflareSandboxProviderOptions) {
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
		const sb = await this.client.create({
			name: opts.name,
			cwd: opts.cwd,
			image: opts.image ?? this.image,
			env: opts.env,
		});
		this.sandboxId = sb.id;
		try {
			// Prefer pre-baked images with tmux; fall back to package install when possible.
			const install = await this.execRaw(
				"command -v tmux >/dev/null 2>&1 || (sudo -n apt-get update -y && sudo -n apt-get install -y tmux) || true",
			);
			const probe = await this.execRaw("command -v tmux");
			if (probe.code !== 0) {
				throw new Error(
					`CloudflareSandboxProvider: tmux missing after install (exit ${install.code}): ${install.stderr || install.stdout}`,
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
		if (!this.sandboxId) {
			throw new Error("CloudflareSandboxProvider.exec called before ensure");
		}
		const r = await this.client.exec(this.sandboxId, cmd);
		return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
	}

	async destroy(): Promise<void> {
		const id = this.sandboxId;
		this.sandboxId = undefined;
		if (!id) return;
		try {
			await this.client.destroy(id);
		} catch {
			/* destroy must never throw */
		}
	}

	get id(): string | undefined {
		return this.sandboxId;
	}
}
