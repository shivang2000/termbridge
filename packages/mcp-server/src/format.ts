// Response formatters that wrap raw handler data into MCP CallToolResult shapes.
// Success: JSON-stringified data in a single text content block. Error: the
// error message in a single text content block with isError:true. The server
// (server.ts) calls these around every tool handler so handlers can return RAW
// data and never construct MCP envelopes themselves.

/** Wrap raw data as a successful MCP text response (JSON-stringified). */
export function formatTextResponse(data: unknown): {
	content: [{ type: "text"; text: string }];
} {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** Wrap an error as a failed MCP text response carrying the message. */
export function formatErrorResponse(err: unknown): {
	content: [{ type: "text"; text: string }];
	isError: true;
} {
	const text = err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text", text }], isError: true };
}
