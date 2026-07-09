// Pluggable delivery targets (Phase 3) — how the engineer-loop ships a change
// after acceptance. Default remains GitHub PR via `gh`; callers can select
// `patch` (raw patch marker) or supply a custom strategy.

export type DeliveryKind = "pr" | "branch" | "patch" | "none";

export interface DeliveryParseResult {
	kind: DeliveryKind;
	/** PR URL when kind === "pr". */
	prUrl?: string;
	/** Branch name when kind is branch/pr/patch. */
	branch?: string;
	/** Patch body or path marker when kind === "patch". */
	patch?: string;
}

export interface DeliveryStrategy {
	/** Stable id for logging / opts.delivery. */
	readonly id: string;
	/** Build the prompt sent to claude after acceptance. */
	buildPrompt(branch: string, opts: { draft: boolean }): string;
	/** Parse the delivery turn screen for markers. */
	parseResult(screen: string): DeliveryParseResult;
}

const LINE_LEAD = "(?:^|[\\r\\n])[ \\t]*(?:[●•·▪▸►❯>][ \\t]*)?";

/** Default: branch + commit + optional gh pr create (existing behaviour). */
export const ghPrDelivery: DeliveryStrategy = {
	id: "gh-pr",
	buildPrompt(branch, { draft }) {
		return [
			`Deliver the change. Create a git branch \`${branch}\` and commit ALL your changes with a clear message referencing the goal.`,
			"If git complains about identity, set it first: git config user.email and user.name.",
			"Then run `gh auth status` to check the GitHub CLI:",
			"- If it SUCCEEDS: run `gh auth setup-git`, push the branch (`git push -u origin " +
				branch +
				"`), open a PR with:",
			`    gh pr create --fill --head ${branch}${draft ? " --draft" : ""}`,
			"  and finally print, on its own line with nothing before it: TB_PR_URL: <the pull request url>",
			`- If gh is NOT available or not authenticated: do NOT push. Print, on its own line: TB_BRANCH_READY: ${branch}`,
		].join("\n");
	},
	parseResult(screen) {
		const pr = new RegExp(`${LINE_LEAD}TB_PR_URL:[ \\t]*(\\S+)`, "im").exec(screen)?.[1];
		const br = new RegExp(`${LINE_LEAD}TB_BRANCH_READY:[ \\t]*(\\S+)`, "im").exec(screen)?.[1];
		if (pr) return { kind: "pr", prUrl: pr, branch: br };
		if (br) return { kind: "branch", branch: br };
		return { kind: "none" };
	},
};

/**
 * Raw patch delivery — no remote push. Claude commits on a branch and prints a
 * unified patch between TB_PATCH_BEGIN / TB_PATCH_END (or TB_PATCH_FILE path).
 */
export const patchDelivery: DeliveryStrategy = {
	id: "patch",
	buildPrompt(branch) {
		return [
			`Deliver the change as a local patch (no remote push).`,
			`Create a git branch \`${branch}\` and commit ALL your changes with a clear message.`,
			"If git complains about identity, set it first: git config user.email and user.name.",
			`Then produce a unified patch of the commit(s) on this branch vs the base branch:`,
			`  git format-patch -1 --stdout   OR   git diff main...HEAD`,
			"Print the patch between these markers (exclusive):",
			"  TB_PATCH_BEGIN",
			"  <patch body>",
			"  TB_PATCH_END",
			`Also print on its own line: TB_BRANCH_READY: ${branch}`,
			"Do NOT open a PR and do NOT push.",
		].join("\n");
	},
	parseResult(screen) {
		const br = new RegExp(`${LINE_LEAD}TB_BRANCH_READY:[ \\t]*(\\S+)`, "im").exec(screen)?.[1];
		const begin = screen.search(/TB_PATCH_BEGIN/i);
		const end = screen.search(/TB_PATCH_END/i);
		let patch: string | undefined;
		if (begin >= 0 && end > begin) {
			const after = screen.indexOf("\n", begin);
			const start = after >= 0 ? after + 1 : begin;
			patch = screen.slice(start, end).trim() || undefined;
		}
		const file = new RegExp(`${LINE_LEAD}TB_PATCH_FILE:[ \\t]*(\\S+)`, "im").exec(screen)?.[1];
		if (file && !patch) patch = file;
		if (patch || br) {
			return { kind: "patch", branch: br, patch };
		}
		return { kind: "none" };
	},
};

/**
 * Gerrit-style delivery — push for review via git push origin HEAD:refs/for/<base>.
 * Marker: TB_GERRIT_REF: <ref or change url>.
 */
export const gerritDelivery: DeliveryStrategy = {
	id: "gerrit",
	buildPrompt(branch) {
		return [
			`Deliver the change for Gerrit review.`,
			`Create a git branch \`${branch}\` and commit ALL your changes with a clear message.`,
			"If git complains about identity, set it first: git config user.email and user.name.",
			"Push for review (adjust remote/base if needed):",
			"  git push origin HEAD:refs/for/main",
			"When the push succeeds, print on its own line: TB_GERRIT_REF: <change-url-or-ref>",
			`If push is impossible, print: TB_BRANCH_READY: ${branch}`,
		].join("\n");
	},
	parseResult(screen) {
		const ref = new RegExp(`${LINE_LEAD}TB_GERRIT_REF:[ \\t]*(\\S+)`, "im").exec(screen)?.[1];
		const br = new RegExp(`${LINE_LEAD}TB_BRANCH_READY:[ \\t]*(\\S+)`, "im").exec(screen)?.[1];
		if (ref) return { kind: "pr", prUrl: ref, branch: br }; // reuse prUrl field for review URL
		if (br) return { kind: "branch", branch: br };
		return { kind: "none" };
	},
};

export const DELIVERY_STRATEGIES: Record<string, DeliveryStrategy> = {
	"gh-pr": ghPrDelivery,
	patch: patchDelivery,
	gerrit: gerritDelivery,
	none: {
		id: "none",
		buildPrompt: () => "",
		parseResult: () => ({ kind: "none" }),
	},
};

/** Resolve a strategy by id or pass-through a custom strategy object. */
export function resolveDelivery(
	input?: string | DeliveryStrategy | false,
): DeliveryStrategy | undefined {
	if (input === false || input === "none" || input === undefined) return undefined;
	if (typeof input === "string") {
		const s = DELIVERY_STRATEGIES[input];
		if (!s) throw new Error(`unknown delivery strategy: ${input}`);
		return s === DELIVERY_STRATEGIES.none ? undefined : s;
	}
	return input;
}
