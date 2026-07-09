import { describe, expect, it } from "bun:test";
import { type CloudflareSandboxClient, CloudflareSandboxProvider } from "./cloudflare-provider.js";

function mockClient(opts?: {
	execResults?: Array<{ exitCode: number; stdout: string; stderr: string }>;
}): {
	client: CloudflareSandboxClient;
	creates: unknown[];
	execs: string[];
	destroys: string[];
} {
	const creates: unknown[] = [];
	const execs: string[] = [];
	const destroys: string[] = [];
	let i = 0;
	const results = opts?.execResults ?? [
		{ exitCode: 0, stdout: "", stderr: "" },
		{ exitCode: 0, stdout: "/usr/bin/tmux", stderr: "" },
	];
	const client: CloudflareSandboxClient = {
		async create(o) {
			creates.push(o);
			return { id: "cf-1" };
		},
		async exec(_id, cmd) {
			execs.push(cmd);
			const r = results[i++] ??
				results[results.length - 1] ?? { exitCode: 0, stdout: "", stderr: "" };
			return r;
		},
		async destroy(id) {
			destroys.push(id);
		},
	};
	return { client, creates, execs, destroys };
}

describe("CloudflareSandboxProvider", () => {
	it("has name cloudflare", () => {
		expect(new CloudflareSandboxProvider({ client: mockClient().client }).name).toBe("cloudflare");
	});

	it("ensure creates sandbox and probes tmux", async () => {
		const m = mockClient();
		const p = new CloudflareSandboxProvider({ client: m.client });
		await p.ensure({ name: "n", cwd: "/home/user" });
		expect(m.creates).toHaveLength(1);
		expect(p.id).toBe("cf-1");
	});

	it("exec returns non-zero as data", async () => {
		const m = mockClient({
			execResults: [
				{ exitCode: 0, stdout: "", stderr: "" },
				{ exitCode: 0, stdout: "/usr/bin/tmux", stderr: "" },
				{ exitCode: 1, stdout: "", stderr: "no server" },
			],
		});
		const p = new CloudflareSandboxProvider({ client: m.client });
		await p.ensure({ name: "n", cwd: "/w" });
		const res = await p.exec(["tmux", "list-sessions"]);
		expect(res.code).toBe(1);
		expect(res.stderr).toBe("no server");
	});

	it("ensure cleans up when tmux is missing", async () => {
		const m = mockClient({
			execResults: [
				{ exitCode: 1, stdout: "", stderr: "fail" },
				{ exitCode: 1, stdout: "", stderr: "missing" },
			],
		});
		const p = new CloudflareSandboxProvider({ client: m.client });
		await expect(p.ensure({ name: "n", cwd: "/w" })).rejects.toThrow(/tmux missing/);
		expect(m.destroys).toEqual(["cf-1"]);
	});
});
