// Public barrel for @termbridge/sandbox-e2b — a concrete SandboxProvider backed
// by the E2B cloud sandbox SDK. @termbridge/core stays dependency-free (D3);
// this package owns the only `e2b` import.
export { E2BSandboxProvider, type E2BSandboxProviderOptions } from "./e2b-provider.js";
export { sandboxProviderFromEnv } from "./from-env.js";
