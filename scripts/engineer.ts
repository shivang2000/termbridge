// Hand off a coding task (e.g. a Jira ticket) to a running termbridge server's
// engineering loop. The server must already be up AND logged in to Claude (open
// <server>/login?token=… once — see the README). Streams progress to stdout.
//
//   bun scripts/engineer.ts \
//     --server http://127.0.0.1:8787 --token SECRET \
//     --repo /work \
//     --goal "PROJ-123: add retry to the upload client — see ticket body" \
//     --accept "uploads retry 3x on 5xx" --accept "the test suite passes" \
//     --verify "npm test" \
//     [--env local|docker] [--rounds 6] [--cadence 25000]
//
// --env defaults to "local" (the published server image runs sessions in-container).
// Use "--env docker" when the server opens per-session containers on a host.

import { runEngineerLoop, type ToolCall } from "../packages/orchestrator/src/index.ts";

function flags(argv: string[]): {
	single: Record<string, string>;
	multi: Record<string, string[]>;
} {
	const single: Record<string, string> = {};
	const multi: Record<string, string[]> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a?.startsWith("--")) continue;
		const key = a.slice(2);
		const val = argv[i + 1] ?? "";
		i++;
		(multi[key] ??= []).push(val);
		single[key] = val;
	}
	return { single, multi };
}

const { single, multi } = flags(process.argv.slice(2));
const server = (single.server ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = single.token ?? process.env.TERMBRIDGE_TOKEN ?? "";
const repo = single.repo ?? "/work";
const goal = single.goal ?? "";
const acceptance = multi.accept ?? [];
const env = (single.env ?? "local") as "local" | "docker";
const verifyCmd = single.verify;
const maxRounds = single.rounds ? Number.parseInt(single.rounds, 10) : 6;
const cadenceMs = single.cadence ? Number.parseInt(single.cadence, 10) : 25_000;

if (!goal) {
	console.error("error: --goal is required (the ticket: title + description + acceptance).");
	process.exit(2);
}

// A ToolCall that POSTs to the server's HTTP tool API (unwraps { ok, data }).
const tools: ToolCall = async (name, args) => {
	const res = await fetch(`${server}/api/tool/${name}?token=${encodeURIComponent(token)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	const j = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
	if (!j.ok) throw new Error(`${name}: ${j.error ?? res.status}`);
	return j.data;
};

console.log(`[engineer] ${server} · repo=${repo} · env=${env}`);
console.log(`[engineer] goal: ${goal}`);

const result = await runEngineerLoop({
	tools,
	task: { goal, acceptance, cwd: repo, env, cmd: "claude", ...(verifyCmd ? { verifyCmd } : {}) },
	maxRounds,
	cadenceMs,
	onDigest: (d) => console.log(`[r${d.round}] ${d.idle ? "(idle) " : ""}${d.summary}`),
	elicitAcceptance: async () => {
		console.warn("[engineer] no --accept given; claude will infer + run the project's tests.");
		return [];
	},
	log: (m) => console.log(`[engineer] · ${m}`),
});

console.log(`\n[engineer] ${result.met ? "✅ DONE" : "⚠️ NOT MET"} — ${result.finalSummary}`);
console.log(`[engineer] watch/inspect: ${server}/?session=${result.sessionId}&token=${token}`);
process.exitCode = result.met ? 0 : 1;
