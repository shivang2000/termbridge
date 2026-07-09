import { describe, expect, it } from "bun:test";
import { gerritDelivery, ghPrDelivery, patchDelivery, resolveDelivery } from "./delivery.js";

describe("delivery strategies", () => {
	it("gh-pr parses TB_PR_URL and TB_BRANCH_READY", () => {
		expect(ghPrDelivery.parseResult("TB_PR_URL: https://github.com/a/b/pull/1\n")).toEqual({
			kind: "pr",
			prUrl: "https://github.com/a/b/pull/1",
			branch: undefined,
		});
		expect(ghPrDelivery.parseResult("TB_BRANCH_READY: tb/foo\n").kind).toBe("branch");
	});

	it("gh-pr prompt includes draft flag when requested", () => {
		expect(ghPrDelivery.buildPrompt("tb/x", { draft: true })).toContain("--draft");
		expect(ghPrDelivery.buildPrompt("tb/x", { draft: false })).not.toContain("--draft");
	});

	it("patch parses markers between BEGIN/END", () => {
		const screen = [
			"TB_BRANCH_READY: tb/fix",
			"TB_PATCH_BEGIN",
			"diff --git a/a b/a",
			"+hello",
			"TB_PATCH_END",
		].join("\n");
		const r = patchDelivery.parseResult(screen);
		expect(r.kind).toBe("patch");
		expect(r.branch).toBe("tb/fix");
		expect(r.patch).toContain("diff --git");
	});

	it("gerrit parses TB_GERRIT_REF", () => {
		const r = gerritDelivery.parseResult("TB_GERRIT_REF: https://gerrit.example/c/1\n");
		expect(r.kind).toBe("pr");
		expect(r.prUrl).toContain("gerrit.example");
	});

	it("resolveDelivery maps ids and custom objects", () => {
		expect(resolveDelivery("gh-pr")?.id).toBe("gh-pr");
		expect(resolveDelivery("patch")?.id).toBe("patch");
		expect(resolveDelivery(false)).toBeUndefined();
		expect(resolveDelivery("none")).toBeUndefined();
		expect(resolveDelivery(undefined)).toBeUndefined();
		expect(() => resolveDelivery("nope")).toThrow(/unknown delivery/);
		expect(resolveDelivery(patchDelivery)?.id).toBe("patch");
	});
});
