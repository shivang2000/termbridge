import { describe, expect, it } from "bun:test";
import type { RecognizedEvent, Recognizer } from "../types.js";
import { RecognizerPipeline } from "./pipeline.js";

/** Build a recognizer that matches whenever `needle` appears in `screen`. */
function stubRecognizer(
	kind: string,
	needle: string,
	data: Record<string, unknown> = {},
): Recognizer {
	return {
		kind,
		match(screen: string): Omit<RecognizedEvent, "kind"> | null {
			return screen.includes(needle) ? { data, suggestedKeys: [] } : null;
		},
	};
}

describe("RecognizerPipeline", () => {
	it("emits nothing when no recognizers are registered", () => {
		const p = new RecognizerPipeline();
		expect(p.process("anything", "")).toEqual([]);
	});

	it("emits an event for a single matching recognizer", () => {
		const p = new RecognizerPipeline();
		p.register(stubRecognizer("yn", "[y/n]", { question: "ok?" }));
		const events = p.process("Proceed? [y/n]", "");
		expect(events).toEqual([{ kind: "yn", data: { question: "ok?" }, suggestedKeys: [] }]);
	});

	it("emits nothing when the registered recognizer does not match", () => {
		const p = new RecognizerPipeline();
		p.register(stubRecognizer("yn", "[y/n]"));
		expect(p.process("nothing here", "")).toEqual([]);
	});

	it("dispatches to multiple recognizers and emits each match", () => {
		const p = new RecognizerPipeline();
		p.register(stubRecognizer("a", "AAA", { v: 1 }));
		p.register(stubRecognizer("b", "BBB", { v: 2 }));
		const events = p.process("AAA and BBB", "");
		expect(events).toEqual([
			{ kind: "a", data: { v: 1 }, suggestedKeys: [] },
			{ kind: "b", data: { v: 2 }, suggestedKeys: [] },
		]);
	});

	it("dedupes an identical event repeated across consecutive calls", () => {
		const p = new RecognizerPipeline();
		p.register(stubRecognizer("yn", "[y/n]", { question: "ok?" }));

		const first = p.process("Proceed? [y/n]", "");
		expect(first).toHaveLength(1);

		const second = p.process("Proceed? [y/n]", "");
		expect(second).toEqual([]);
	});

	it("re-emits when the same kind's data changes", () => {
		const p = new RecognizerPipeline();
		// Recognizer whose payload depends on the screen content.
		const dynamic: Recognizer = {
			kind: "oauth-url",
			match(screen: string): Omit<RecognizedEvent, "kind"> | null {
				const m = screen.match(/url=(\S+)/);
				return m?.[1] ? { data: { url: m[1] }, suggestedKeys: [] } : null;
			},
		};
		p.register(dynamic);

		expect(p.process("url=https://a", "")).toEqual([
			{ kind: "oauth-url", data: { url: "https://a" }, suggestedKeys: [] },
		]);
		// same payload → deduped
		expect(p.process("url=https://a", "")).toEqual([]);
		// changed payload → emitted again
		expect(p.process("url=https://b", "")).toEqual([
			{ kind: "oauth-url", data: { url: "https://b" }, suggestedKeys: [] },
		]);
	});

	it("re-emits an identical payload after the recognizer stopped matching in between", () => {
		const p = new RecognizerPipeline();
		p.register(stubRecognizer("yn", "[y/n]", { question: "ok?" }));

		expect(p.process("Proceed? [y/n]", "")).toHaveLength(1);
		// gap: recognizer does not match
		expect(p.process("working...", "")).toEqual([]);
		// prompt reappears → fresh emission (the previous one was answered)
		expect(p.process("Proceed? [y/n]", "")).toHaveLength(1);
	});

	it("dedupes per kind independently", () => {
		const p = new RecognizerPipeline();
		p.register(stubRecognizer("a", "AAA", { v: 1 }));
		p.register(stubRecognizer("b", "BBB", { v: 2 }));

		expect(p.process("AAA BBB", "")).toHaveLength(2);
		// a unchanged but b removed → only b can re-emit when it returns
		expect(p.process("AAA", "")).toEqual([]);
		expect(p.process("AAA BBB", "")).toEqual([{ kind: "b", data: { v: 2 }, suggestedKeys: [] }]);
	});

	it("passes recentBytes through to recognizers", () => {
		const p = new RecognizerPipeline();
		const r: Recognizer = {
			kind: "recent",
			match(_screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
				return recentBytes.includes("token") ? { data: {}, suggestedKeys: [] } : null;
			},
		};
		p.register(r);
		expect(p.process("", "got a token")).toHaveLength(1);
		expect(p.process("", "nothing")).toEqual([]);
	});
});
