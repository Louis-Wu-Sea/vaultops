/**
 * VaultOps MCP server — local-first Obsidian task management.
 *
 * All tools read/write local Obsidian markdown files. No backend required.
 * Runs as a stdio MCP server (JSON-RPC 2.0 over stdin/stdout) for Claude Code.
 */

import { readMessages, sendMessage } from "./transport.js";
import { dispatch, jsonError, type ToolRegistry } from "./dispatch.js";
import { listTools, callTool } from "./tools/index.js";

// ── Tool registry ─────────────────────────────────────────────────────

const registry: ToolRegistry = {
  listTools,
  callTool: (params) => {
    const name = params.name as string;
    const args = (params.arguments as Record<string, unknown>) ?? {};
    return callTool(name, args);
  },
};

// ── Main async stdio loop ─────────────────────────────────────────────

async function main(): Promise<void> {
  for await (const message of readMessages()) {
    try {
      const response = dispatch(message, registry);
      if (response !== null) {
        sendMessage(response);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`vaultops-mcp: ${errMsg}\n`);
      try {
        const msgId =
          (message as unknown as Record<string, unknown>)?.id as
            | string
            | number
            | null ?? null;
        if (msgId !== null) {
          sendMessage(jsonError(msgId, -32603, errMsg));
        }
      } catch {
        // ignore send errors during error handling
      }
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `vaultops-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
