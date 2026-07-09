// HTTP client for the termbridge Cloudflare Containers control Worker.
import type { CloudflareSandboxClient } from "./cloudflare-provider.js";

export interface CreateCloudflareClientOptions {
	/** Control Worker base URL, e.g. https://termbridge-sandbox.<subdomain>.workers.dev */
	workerUrl?: string;
	/** Bearer token (must match Worker CONTROL_TOKEN secret). Defaults to CLOUDFLARE_CONTROL_TOKEN or CLOUDFLARE_API_TOKEN. */
	controlToken?: string;
}

/**
 * Talks to the deployed termbridge-sandbox Worker (POST /create|/exec|/destroy).
 * Deploy: packages/sandbox-cloudflare/worker via wrangler (see scripts/deploy-cloudflare-sandbox.ts).
 */
export function createCloudflareClientFromEnv(
	opts: CreateCloudflareClientOptions = {},
): CloudflareSandboxClient {
	const base = (
		opts.workerUrl ??
		process.env.CLOUDFLARE_SANDBOX_WORKER_URL ??
		""
	).replace(/\/$/, "");
	const token =
		opts.controlToken ??
		process.env.CLOUDFLARE_CONTROL_TOKEN ??
		process.env.CLOUDFLARE_API_TOKEN ??
		"";
	if (!base) {
		throw new Error(
			"CLOUDFLARE_SANDBOX_WORKER_URL is required (deploy packages/sandbox-cloudflare/worker first)",
		);
	}
	if (!token) {
		throw new Error("CLOUDFLARE_CONTROL_TOKEN (or CLOUDFLARE_API_TOKEN) is required");
	}

	async function call(
		path: string,
		init?: RequestInit,
	): Promise<Record<string, unknown>> {
		const res = await fetch(`${base}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...(init?.headers ?? {}),
			},
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			throw new Error(
				`Cloudflare control ${path} → ${res.status}: ${JSON.stringify(body)}`,
			);
		}
		return body;
	}

	const client: CloudflareSandboxClient = {
		async create(o) {
			const body = await call("/create", {
				method: "POST",
				body: JSON.stringify({ name: o.name, cwd: o.cwd, env: o.env }),
			});
			const id = String(body.id ?? "");
			if (!id) throw new Error("Cloudflare /create returned no id");
			return { id };
		},
		async exec(id, cmd) {
			const body = await call(`/exec?id=${encodeURIComponent(id)}`, {
				method: "POST",
				body: JSON.stringify({ cmd }),
			});
			return {
				exitCode: Number(body.exitCode ?? 1),
				stdout: String(body.stdout ?? ""),
				stderr: String(body.stderr ?? ""),
			};
		},
		async destroy(id) {
			await call(`/destroy?id=${encodeURIComponent(id)}`, { method: "POST" });
		},
	};
	return client;
}
