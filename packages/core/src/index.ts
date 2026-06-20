// Public barrel for @termbridge/core.
// Exports the shared contracts plus every M1 unit: tmux helpers, WriteLock,
// recognizers (registry + url-detector + oauth-url), PtyObserver,
// LocalEnvironment, Session, and SessionManager.

// pluggable execution backend (D4)
export * from "./env/docker.js";
export * from "./env/local.js";
export * from "./manager.js";
// per-session PTY observer (D6)
export * from "./observer/pty-observer.js";
export * from "./recognizers/oauth-url.js";
export * from "./recognizers/pipeline.js";
// pluggable prompt recognizers (D7)
export * from "./recognizers/url-detector.js";
// the shared interactive session + registry (D8)
export * from "./session/session.js";
// human/agent write arbitration
export * from "./session/write-lock.js";
// tmux substrate (D1)
export * from "./tmux/helpers.js";
export * from "./types.js";
