#!/usr/bin/env node
// Published CLI entry (Node). `npx @termbridge/mcp-server` runs this.
// It unconditionally starts the stdio server (unlike stdio.ts, which guards on
// import.meta.main for bun-dev and is also imported by tests for `runServer`).
import { runServer } from "./stdio.js";

runServer().catch((err) => {
	console.error(err);
	process.exit(1);
});
