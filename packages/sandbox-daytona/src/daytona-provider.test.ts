import { describe, expect, it } from "bun:test";
import { type DaytonaClient, DaytonaSandboxProvider } from "./daytona-provider.js";

function mockClient(opts?: {
	execResults?: Array<{ exitCode: number; stdout: string; stderr: string }>;
	failCreate?: boolean;
}): {
	client: DaytonaClient;
	creates: unknown[];
	execs: string[];
	destroys: string[];
} {
	const creates: unknown[] = [];
	const execs: string[] = [];
	const destroys: string[] = [];
	let i = 0;
	const results = opts?.execResults ?? [{ exitCode: 0, stdout: "/usr/bin/tmux", stderr: "" }];
	const client: DaytonaClient = {
		async create(o) {
			if (opts?.failCreate) throw new Error("create failed");
			creates.push(o);
			return { id: "ws-1" };
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

describe("DaytonaSandboxProvider", () => {
	it("has name daytona", () => {
		expect(new DaytonaSandboxProvider({ client: mockClient().client }).name).toBe("daytona");
	});

	it("ensure creates workspace, installs tmux, and records id", async () => {
		const m = mockClient();
		const p = new DaytonaSandboxProvider({ client: m.client, image: "ubuntu:22.04" });
		await p.ensure({ name: "sess", cwd: "/work", env: { A: "1" } });
		expect(m.creates).toEqual([
			{ name: "sess", cwd: "/work", image: "ubuntu:22.04", env: { A: "1" } },
		]);
		expect(p.id).toBe("ws-1");
		expect(m.execs.some((c) => c.includes("tmux"))).toBe(true);
	});

	it("exec shell-joins argv", async () => {
		const m = mockClient({
			execResults: [
				{ exitCode: 0, stdout: "/usr/bin/tmux", stderr: "" },
				{ exitCode: 0, stdout: "ok", stderr: "" },
			],
		});
		const p = new DaytonaSandboxProvider({ client: m.client });
		await p.ensure({ name: "s", cwd: "/w" });
		const res = await p.exec(["tmux", "-L", "termbridge", "list-sessions"]);
		expect(res).toEqual({ stdout: "ok", stderr: "", code: 0 });
		expect(m.execs.at(-1)).toContain("tmux -L termbridge list-sessions");
	});

	it("ensure destroys workspace when tmux probe fails", async () => {
		const m = mockClient({
			execResults: [{ exitCode: 1, stdout: "", stderr: "no tmux" }],
		});
		const p = new DaytonaSandboxProvider({ client: m.client });
		await expect(p.ensure({ name: "s", cwd: "/w" })).rejects.toThrow(/tmux missing/);
		expect(m.destroys).toEqual(["ws-1"]);
		expect(p.id).toBeUndefined();
	});

	it("destroy is best-effort and idempotent", async () => {
		const m = mockClient();
		const p = new DaytonaSandboxProvider({ client: m.client });
		await p.ensure({ name: "s", cwd: "/w" });
		await p.destroy();
		await p.destroy();
		expect(m.destroys).toEqual(["ws-1"]);
	});
});
