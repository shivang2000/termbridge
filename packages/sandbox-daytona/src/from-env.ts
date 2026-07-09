// Real Daytona SDK adapter → DaytonaClient interface.
// Optional peer: install `@daytona/sdk` for live use. Unit tests inject a mock.
import type { DaytonaClient } from "./daytona-provider.js";

export interface CreateDaytonaClientOptions {
	apiKey?: string;
	apiUrl?: string;
	target?: string;
}

/**
 * Build a DaytonaClient from env / options using `@daytona/sdk`.
 * Requires: `bun add @daytona/sdk` (or npm) in the consumer / monorepo.
 */
export async function createDaytonaClientFromEnv(
	opts: CreateDaytonaClientOptions = {},
): Promise<DaytonaClient> {
	const apiKey = opts.apiKey ?? process.env.DAYTONA_API_KEY;
	if (!apiKey) {
		throw new Error("DAYTONA_API_KEY is required");
	}
	// Dynamic import so package unit tests don't need the SDK installed as a hard dep
	// when only using injectable mocks.
	const { Daytona } = await import("@daytona/sdk");
	const daytona = new Daytona({
		apiKey,
		...(opts.apiUrl ?? process.env.DAYTONA_API_URL
			? { apiUrl: opts.apiUrl ?? process.env.DAYTONA_API_URL }
			: {}),
		...(opts.target ?? process.env.DAYTONA_TARGET
			? { target: opts.target ?? process.env.DAYTONA_TARGET }
			: {}),
	});

	/** Live sandbox handles keyed by id for exec/destroy. */
	const live = new Map<string, { delete: (t?: number) => Promise<void>; process: { executeCommand: (cmd: string, cwd?: string) => Promise<{ exitCode: number; result: string }> } }>();

	const client: DaytonaClient = {
		async create(o) {
			const sandbox = await daytona.create({
				language: "typescript",
				ephemeral: true,
				autoStopInterval: 10,
				autoDeleteInterval: 0, // delete on stop
				envVars: o.env,
				labels: { termbridge: "1", name: o.name },
				...(o.image ? { image: o.image } : {}),
			});
			live.set(sandbox.id, sandbox);
			return { id: sandbox.id };
		},
		async exec(id, cmd) {
			const sb = live.get(id);
			if (!sb) throw new Error(`DaytonaClient: unknown sandbox ${id}`);
			const r = await sb.process.executeCommand(cmd);
			return {
				exitCode: r.exitCode,
				stdout: r.result ?? "",
				stderr: "",
			};
		},
		async destroy(id) {
			const sb = live.get(id);
			live.delete(id);
			if (!sb) {
				// Best-effort: try SDK get+delete by id if handle lost
				try {
					const found = await daytona.get(id);
					await found.delete();
				} catch {
					/* gone */
				}
				return;
			}
			await sb.delete();
		},
	};
	return client;
}
