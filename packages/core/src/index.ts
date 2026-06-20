// Public barrel for @termbridge/core.
// The scaffold exports only the shared contracts; M1 units extend this barrel
// (tmux helpers, WriteLock, recognizers, PtyObserver, LocalEnvironment, Session,
// SessionManager) during the integration pass.
export * from "./types.js";
