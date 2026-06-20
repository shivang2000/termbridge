import type { RecognizedEvent, Recognizer } from "../types.js";

/**
 * Runs a registry of {@link Recognizer}s over each captured screen poll and
 * emits a {@link RecognizedEvent} per non-null match (D7).
 *
 * Dedupe semantics: a recognizer's prompt typically stays on screen across
 * many polls (the OAuth URL is visible until the human acts), so naively
 * emitting every poll would flood the agent with duplicates. The pipeline
 * therefore suppresses an emission when it is identical (same `kind` and same
 * JSON-serialized `data`) to that kind's immediately-preceding emission.
 *
 * "Immediately-preceding" is across calls: the last payload remembered for a
 * kind persists until that kind either emits a *different* payload (re-emit)
 * or stops matching entirely (state cleared, so the next reappearance — e.g.
 * the prompt returning after being answered — emits fresh).
 */
export class RecognizerPipeline {
	private readonly recognizers: Recognizer[] = [];
	/** Last emitted JSON payload per kind, while that kind is still matching. */
	private readonly lastEmitted = new Map<string, string>();

	register(r: Recognizer): void {
		this.recognizers.push(r);
	}

	process(screen: string, recentBytes: string): RecognizedEvent[] {
		const events: RecognizedEvent[] = [];

		for (const r of this.recognizers) {
			const match = r.match(screen, recentBytes);

			if (!match) {
				// No longer matching: forget prior state so a later reappearance
				// (a re-asked prompt) counts as a fresh event.
				this.lastEmitted.delete(r.kind);
				continue;
			}

			const event: RecognizedEvent = {
				kind: r.kind,
				data: match.data,
				suggestedKeys: match.suggestedKeys,
			};
			const signature = JSON.stringify(event.data);

			if (this.lastEmitted.get(r.kind) === signature) {
				// Identical to the previous consecutive emission for this kind: dedupe.
				continue;
			}

			this.lastEmitted.set(r.kind, signature);
			events.push(event);
		}

		return events;
	}
}
