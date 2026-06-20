// Public barrel for @termbridge/mcp-server — the MCP stdio server over
// @termbridge/core (M3). D3: this package owns the MCP SDK; core stays MCP-free.

export { formatErrorResponse, formatTextResponse } from "./format.js";
export { type CreateServerOptions, createServer } from "./server.js";
export { runServer } from "./stdio.js";
export { createToolSpecs, type ToolSpec } from "./tools.js";
