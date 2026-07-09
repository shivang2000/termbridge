/**
 * P2.1 corpus guard — every screen fixture under __fixtures__/ must still
 * match its recognizer. Fails loudly on TUI drift (path + kind in the message).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type { Recognizer } from "../types.js";
import { claudeActivityRecognizer } from "./claude-activity.js";
import { claudePermissionRecognizer } from "./claude-permission.js";
import { genericYnRecognizer } from "./generic-yn.js";
import { oauthUrlRecognizer } from "./oauth-url.js";
import { rateLimitRecognizer } from "./rate-limit.js";
import { needsUserInputMarkerRecognizer, selfCheckMarkerRecognizer } from "./tb-marker.js";

const FIXTURES_ROOT = join(import.meta.dir, "__fixtures__");

/** Directory name under __fixtures__/ → recognizer that must match every .txt there. */
const CORPUS: Record<string, Recognizer> = {
	"claude-permission": claudePermissionRecognizer,
	"claude-activity": claudeActivityRecognizer,
	"oauth-url": oauthUrlRecognizer,
	"rate-limit": rateLimitRecognizer,
	"generic-yn": genericYnRecognizer,
	"tb-marker-ask": needsUserInputMarkerRecognizer,
	"tb-marker-self-check": selfCheckMarkerRecognizer,
};

function listTxtFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) continue;
		if (name.endsWith(".txt")) out.push(full);
	}
	return out;
}

describe("recognizer corpus guard (P2.1)", () => {
	it("registers every corpus directory", () => {
		const dirs = readdirSync(FIXTURES_ROOT).filter((name) => {
			const full = join(FIXTURES_ROOT, name);
			return statSync(full).isDirectory() && !name.startsWith(".");
		});
		for (const dir of dirs) {
			expect(CORPUS[dir], `unknown fixture dir "${dir}" — add it to CORPUS in corpus.guard.test.ts`).toBeDefined();
		}
		expect(dirs.length).toBeGreaterThan(0);
	});

	for (const [dir, recognizer] of Object.entries(CORPUS)) {
		const dirPath = join(FIXTURES_ROOT, dir);
		const files = listTxtFiles(dirPath);
		it(`${dir}/ has at least one fixture`, () => {
			expect(files.length, `no .txt fixtures in ${dir}/`).toBeGreaterThan(0);
		});
		for (const file of files) {
			const rel = `${dir}/${file.slice(dirPath.length + 1)}`;
			it(`${rel} matches kind=${recognizer.kind}`, () => {
				const screen = readFileSync(file, "utf8");
				const out = recognizer.match(screen, "");
				expect(
					out,
					`DRIFT: fixture ${rel} no longer matches recognizer kind=${recognizer.kind}. Re-capture or re-tune packages/core/src/recognizers/.`,
				).not.toBeNull();
			});
		}
	}
});
