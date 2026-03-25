/**
 * JSON-RPC 2.0 method dispatcher.
 *
 * Ported from Python's _dispatch() (lines 5546-5577).
 * Routes: initialize, tools/list, tools/call, ping.
 */

import type { JsonRpcRequest, JsonRpcResponse, ToolResult } from "./types.js";

// ── JSON-RPC helpers ───────────────────────────────────────────────────

export function jsonResponse(msgId: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: msgId, result };
}

export function jsonError(msgId: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: msgId, error: { code, message } };
}

/**
 * Format a tool result for MCP protocol.
 */
export function toolResult(data: unknown, isError = false): ToolResult {
  const text = typeof data === "object" && data !== null
    ? JSON.stringify(data, null, 2)
    : String(data);
  return { content: [{ type: "text", text }], isError: isError || undefined };
}

// ── Supported protocol versions ────────────────────────────────────────

const SUPPORTED_VERSIONS = new Set(["2024-10-07", "2024-11-05", "2025-03-26"]);

// ── Tool registry interface ────────────────────────────────────────────

export interface ToolRegistry {
  listTools: () => { tools: unknown[] };
  callTool: (params: Record<string, unknown>) => ToolResult;
}

// ── Dispatcher ─────────────────────────────────────────────────────────

/**
 * Dispatch a JSON-RPC message and return a response (or null for notifications).
 */
export function dispatch(message: JsonRpcRequest, registry: ToolRegistry): JsonRpcResponse | null {
  const { method, id: msgId, params = {} } = message;

  if (method === "initialize") {
    const clientVersion = (params as Record<string, string>).protocolVersion ?? "2025-03-26";
    const negotiated = SUPPORTED_VERSIONS.has(clientVersion) ? clientVersion : "2025-03-26";
    return jsonResponse(msgId ?? null, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: "vaultops", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return null; // Notification — no response
  }

  if (method === "tools/list") {
    return jsonResponse(msgId ?? null, registry.listTools());
  }

  if (method === "tools/call") {
    const result = registry.callTool(params as Record<string, unknown>);
    return jsonResponse(msgId ?? null, result);
  }

  if (method === "ping") {
    return jsonResponse(msgId ?? null, {});
  }

  // Unknown method
  if (msgId != null) {
    return jsonError(msgId, -32601, "Method not found");
  }

  return null;
}
