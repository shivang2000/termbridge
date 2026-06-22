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
//     [--env local|docker] [--rounds 6] [--cadence 25000] \
//     [--pr ask|ready|draft|none] [--branch tb/foo] [--base main]
//
// --env defaults to "local" (host tmux -L termbridge; uses your host git/gh).
//   Use "--env docker" for an isolated per-session container.
// --pr defaults to "ask" (prompt before opening; non-TTY → draft). After acceptance,
//   claude commits a branch; it opens the PR in-session if gh is authed (GH_TOKEN),
//   else this CLI pushes + opens it from the host (your gh auth — no token needed).

import { execFileSync } from "node:child_process";
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

// Delivery: --pr ask|ready|draft|none (default ask; non-TTY → draft), --branch, --base.
const prMode = (single.pr ?? "ask") as "ask" | "ready" | "draft" | "none";
const openPr = prMode !== "none";
const branch = single.branch;
const base = single.base;
let prReady = prMode === "ready"; // captured so the host fallback knows draft vs ready

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

console.log(`[engineer] ${server} · repo=${repo} · env=${env} · pr=${prMode}`);
if (env === "local") {
	console.log(
		"[engineer] local mode: sessions run on tmux -L termbridge — your default tmux is untouched",
	);
}
console.log(`[engineer] goal: ${goal}`);

// Human gate before opening a PR (outward). y → ready PR; anything else / non-TTY → draft.
async function confirmPr(): Promise<boolean> {
	if (prMode === "ready") {
		prReady = true;
		return true;
	}
	if (!process.stdin.isTTY) {
		console.log("[engineer] non-interactive — opening a DRAFT PR");
		prReady = false;
		return false;
	}
	const ans = prompt("[engineer] acceptance met. Open a PR now? [y/N]");
	prReady = /^y(es)?$/i.test((ans ?? "").trim());
	return prReady;
}

const result = await runEngineerLoop({
	tools,
	task: { goal, acceptance, cwd: repo, env, cmd: "claude", ...(verifyCmd ? { verifyCmd } : {}) },
	maxRounds,
	cadenceMs,
	openPr,
	...(branch ? { branch } : {}),
	...(prMode === "draft" ? { prDraft: true } : {}),
	...(openPr && prMode !== "draft" ? { confirmPr } : {}),
	onDigest: (d) => console.log(`[r${d.round}] ${d.idle ? "(idle) " : ""}${d.summary}`),
	elicitAcceptance: async () => {
		console.warn("[engineer] no --accept given; claude will infer + run the project's tests.");
		return [];
	},
	log: (m) => console.log(`[engineer] · ${m}`),
});

console.log(`\n[engineer] ${result.met ? "✅ DONE" : "⚠️ NOT MET"} — ${result.finalSummary}`);

// Delivery: claude opened the PR itself, OR it committed a branch and we push + open
// the PR from the host (using the host's gh auth — the no-token laptop path).
if (result.prUrl) {
	console.log(`[engineer] 🔀 PR: ${result.prUrl}`);
} else if (result.delivery === "branch" && result.branch) {
	console.log(
		`[engineer] branch committed: ${result.branch} — pushing + opening the PR from the host…`,
	);
	try {
		execFileSync("git", ["-C", repo, "push", "-u", "origin", result.branch], { stdio: "inherit" });
		const prArgs = [
			"pr",
			"create",
			"--fill",
			"--head",
			result.branch,
			...(base ? ["--base", base] : []),
			...(prReady ? [] : ["--draft"]),
		];
		const url = execFileSync("gh", prArgs, { cwd: repo, encoding: "utf8" }).trim();
		console.log(`[engineer] 🔀 PR: ${url}`);
	} catch (e) {
		console.error(`[engineer] host push/PR failed: ${e instanceof Error ? e.message : String(e)}`);
		console.error(`[engineer] branch ${result.branch} is committed in ${repo} — push it manually.`);
	}
}

console.log(`[engineer] watch/inspect: ${server}/?session=${result.sessionId}&token=${token}`);
process.exitCode = result.met ? 0 : 1;
