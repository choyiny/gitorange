/**
 * A tool-level failure: returned as a tool result with `isError: true` (the JSON-RPC call itself
 * succeeds). The message is written for the caller and is safe to show.
 */
export class McpToolError extends Error {}
