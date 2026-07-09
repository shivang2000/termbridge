/**
 * termbridge Cloudflare Containers control plane.
 * HTTP API (Bearer CONTROL_TOKEN):
 *   POST /create  → { id }
 *   POST /exec?id=  body { cmd } → { exitCode, stdout, stderr }
 *   POST /destroy?id=
 */
import { Container, getContainer } from "@cloudflare/containers";

export class TermbridgeSandbox extends Container {
	// No HTTP server in the image — we only use exec().
	sleepAfter = "10m";
	entrypoint = ["sleep", "infinity"];
	enableInternet = true;

	async shell(cmd: string): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}> {
		// start() without ports for batch-style containers
		// @ts-expect-error container runtime types vary by workers version
		if (!this.ctx.container?.running) {
			await this.start({
				entrypoint: ["sleep", "infinity"],
				enableInternet: true,
			});
		}
		// @ts-expect-error
		const process = await this.ctx.container.exec(["bash", "-lc", cmd]);
		const output = await process.output();
		const dec = new TextDecoder();
		return {
			exitCode: output.exitCode,
			stdout: dec.decode(output.stdout),
			stderr: dec.decode(output.stderr),
		};
	}

	async killSandbox(): Promise<void> {
		await this.destroy();
	}
}

interface Env {
	SANDBOX: DurableObjectNamespace;
	CONTROL_TOKEN: string;
}

function unauthorized(): Response {
	return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function checkAuth(request: Request, env: Env): boolean {
	const h = request.headers.get("authorization") ?? "";
	const expected = `Bearer ${env.CONTROL_TOKEN}`;
	return h === expected && env.CONTROL_TOKEN.length > 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!checkAuth(request, env)) return unauthorized();

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === "/healthz") {
				return Response.json({ ok: true });
			}

			if (path === "/create" && request.method === "POST") {
				const id = crypto.randomUUID();
				const c = getContainer(env.SANDBOX, id) as DurableObjectStub & {
					shell: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
				};
				// Boot the container
				const probe = await c.shell("echo ready && command -v tmux && tmux -V");
				if (probe.exitCode !== 0) {
					await (
						getContainer(env.SANDBOX, id) as DurableObjectStub & {
							killSandbox: () => Promise<void>;
						}
					).killSandbox();
					return Response.json(
						{ ok: false, error: "boot_failed", detail: probe },
						{ status: 500 },
					);
				}
				return Response.json({ ok: true, id, probe });
			}

			if (path === "/exec" && request.method === "POST") {
				const id = url.searchParams.get("id");
				if (!id) return Response.json({ ok: false, error: "missing id" }, { status: 400 });
				const body = (await request.json().catch(() => ({}))) as { cmd?: string };
				if (!body.cmd) return Response.json({ ok: false, error: "missing cmd" }, { status: 400 });
				const c = getContainer(env.SANDBOX, id) as DurableObjectStub & {
					shell: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
				};
				const result = await c.shell(body.cmd);
				return Response.json({ ok: true, ...result });
			}

			if (path === "/destroy" && request.method === "POST") {
				const id = url.searchParams.get("id");
				if (!id) return Response.json({ ok: false, error: "missing id" }, { status: 400 });
				const c = getContainer(env.SANDBOX, id) as DurableObjectStub & {
					killSandbox: () => Promise<void>;
				};
				await c.killSandbox();
				return Response.json({ ok: true, id });
			}

			return Response.json({ ok: false, error: "not_found" }, { status: 404 });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return Response.json({ ok: false, error: msg }, { status: 500 });
		}
	},
};
