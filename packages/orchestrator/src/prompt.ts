// prompt.ts — the three text prompts the loop sends into the claude session:
// the initial engineering prompt, the corrective nudge, and the delivery
// (branch/commit/push/PR) prompt. Factored out of engineer-loop.ts (P1.3) so
// prompt wording is isolated from loop control flow and easy to tune.

import { DONE_SENTINEL } from "./parse.js";
import type { AssessResult, EngineerTask } from "./types.js";

/** Build the structured engineering prompt sent to claude at the start of the loop. */
export function buildEngineerPrompt(task: EngineerTask, acceptance: string[]): string {
	const criteria = acceptance.length
		? acceptance.map((a) => `- ${a}`).join("\n")
		: "- (none specified — infer reasonable criteria from the goal and the repo)";
	const verify = task.verifyCmd
		? `Verify your work by running: ${task.verifyCmd}`
		: "Find and run the project's tests/build to verify your work.";
	return [
		"You are an autonomous software engineer working in this repository. Complete the goal end to end.",
		"",
		"GOAL:",
		task.goal,
		"",
		"ACCEPTANCE CRITERIA (ALL must hold before you finish):",
		criteria,
		"",
		"RULES:",
		"- Work step by step; edit files and run commands as needed.",
		`- ${verify}`,
		`- When (and ONLY when) EVERY acceptance criterion holds AND your verification passes, print a line that STARTS with the marker (nothing before it on that line): ${DONE_SENTINEL} PASS`,
		`- If the task genuinely cannot be completed, instead print a line that starts with: ${DONE_SENTINEL} FAIL <one-line reason>`,
		`- Do NOT print the ${DONE_SENTINEL} marker until you have actually run the verification.`,
		`- If you need a decision or piece of information from the user that you cannot safely assume — an ambiguous requirement, a missing API key or credential, a choice between approaches, environment-specific config — print a line that STARTS with TB_ASK: <your question>. The operator will relay it to the user and forward the answer back into this terminal. Do NOT guess on ambiguous requirements; do NOT pause silently waiting for input.`,
	].join("\n");
}

/** Build the corrective nudge sent when a turn ended without the completion sentinel. */
export function correctivePrompt(acceptance: string[], assessed: AssessResult): string {
	if (assessed.done && !assessed.pass) {
		return [
			"You printed a FAIL. Re-examine the goal and try a different approach.",
			assessed.reason ? `Your stated blocker: ${assessed.reason}` : "",
			`When every criterion holds and verification passes, print "${DONE_SENTINEL} PASS".`,
		]
			.filter(Boolean)
			.join("\n");
	}
	const criteria = acceptance.length
		? `\nRemaining criteria:\n${acceptance.map((a) => `- ${a}`).join("\n")}`
		: "";
	return [
		"Continue. You have not yet printed the completion sentinel.",
		"Finish the remaining work, RUN the verification, and only then print",
		`"${DONE_SENTINEL} PASS" (or "${DONE_SENTINEL} FAIL <reason>" if blocked).${criteria}`,
	].join("\n");
}

/** Prompt sent AFTER acceptance is met to deliver the change (branch/commit/push/PR). */
export function buildDeliveryPrompt(branch: string, draft: boolean): string {
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
}
