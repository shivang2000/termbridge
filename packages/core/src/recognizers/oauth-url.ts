import type { RecognizedEvent, Recognizer } from "../types.js";
import { detectDeviceCode, detectOAuthPrompt } from "./url-detector.js";

/**
 * `oauth-url` recognizer (D7). Detects the one-time OAuth login prompt that
 * `claude`, `gh`, and `sentry-cli` print — a sign-in URL plus an optional
 * device code. The agent layer surfaces this so a human (or an automated
 * login flow) can complete the one-time browser auth; afterwards every
 * session reuses the persisted credentials (subscription, not API).
 *
 * Detection runs against the captured screen first, falling back to the
 * recently-piped bytes so a URL that has already scrolled off the visible
 * pane is still caught. `suggestedKeys` is empty: there is no keypress that
 * answers this prompt — the human acts out-of-band in a browser.
 */
export const oauthUrlRecognizer: Recognizer = {
	kind: "oauth-url",
	match(screen: string, recentBytes: string): Omit<RecognizedEvent, "kind"> | null {
		const found = detectOAuthPrompt(screen) ?? detectOAuthPrompt(recentBytes);
		if (!found) return null;

		const code = detectDeviceCode(screen) ?? detectDeviceCode(recentBytes);
		const data: Record<string, unknown> = code ? { url: found.url, code } : { url: found.url };

		return { data, suggestedKeys: [] };
	},
};
