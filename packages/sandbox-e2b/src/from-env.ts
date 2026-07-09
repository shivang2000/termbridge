// Optional env-based wiring: when E2B_API_KEY is set, return a live provider so
// callers (server / mcp-server) can enable env:"sandbox" without custom code.
import type { SandboxProvider } from "@termbridge/core";
import { E2BSandboxProvider } from "./e2b-provider.js";

/**
 * Returns an `E2BSandboxProvider` when `E2B_API_KEY` is set (or `apiKey` is
 * passed), otherwise `undefined`. Never throws for a missing key.
 */
export function sandboxProviderFromEnv(opts?: { apiKey?: string }): SandboxProvider | undefined {
	const apiKey = opts?.apiKey ?? process.env.E2B_API_KEY;
	if (!apiKey) return undefined;
	return new E2BSandboxProvider({ apiKey });
}
