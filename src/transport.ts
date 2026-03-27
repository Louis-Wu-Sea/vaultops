/**
 * JSON-RPC 2.0 stdio transport — auto-detects format.
 *
 * Claude Code ≥2.1.80 switched from Content-Length framing (LSP-style) to
 * newline-delimited JSON (NDJSON). This transport supports both:
 *
 * - NDJSON: each message is a single JSON line terminated by '\n'.
 *   Detected when the first non-empty byte is '{'.
 * - Content-Length: 'Content-Length: N\r\n\r\n<body>' (legacy LSP style).
 *   Detected when the first non-empty bytes are 'Content-Length:'.
 *
 * Output always uses NDJSON ('JSON\n') because Claude Code now expects it.
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

/**
 * Async generator that yields JSON-RPC messages read from stdin.
 * Auto-detects transport format on first message.
 * Ends naturally when stdin closes (EOF).
 */
export async function* readMessages(): AsyncGenerator<JsonRpcRequest> {
  let textBuf = "";
  let mode: "unknown" | "ndjson" | "content-length" = "unknown";
  let clBuf = Buffer.alloc(0); // used only in content-length mode

  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    if (mode === "content-length") {
      // Legacy path: accumulate binary buffer, parse Content-Length frames
      clBuf = Buffer.concat([clBuf, chunk as Buffer]);
      let parsed = tryParseContentLength(clBuf);
      while (parsed !== null) {
        clBuf = clBuf.slice(parsed.consumed);
        yield parsed.message;
        parsed = tryParseContentLength(clBuf);
      }
      continue;
    }

    // Detect format from the first bytes
    textBuf += (chunk as Buffer).toString("utf-8");

    if (mode === "unknown") {
      const trimmed = textBuf.trimStart();
      if (trimmed.startsWith("Content-Length:")) {
        mode = "content-length";
        clBuf = Buffer.from(textBuf, "utf-8");
        textBuf = "";
        let parsed = tryParseContentLength(clBuf);
        while (parsed !== null) {
          clBuf = clBuf.slice(parsed.consumed);
          yield parsed.message;
          parsed = tryParseContentLength(clBuf);
        }
        continue;
      } else if (trimmed.startsWith("{")) {
        mode = "ndjson";
      }
      // If neither, keep accumulating until we can detect
    }

    if (mode === "ndjson" || mode === "unknown") {
      // Parse all complete newline-terminated JSON objects
      let nlIdx: number;
      while ((nlIdx = textBuf.indexOf("\n")) !== -1) {
        const line = textBuf.slice(0, nlIdx).trimEnd();
        textBuf = textBuf.slice(nlIdx + 1);
        if (!line || !line.startsWith("{")) continue;
        try {
          yield JSON.parse(line) as JsonRpcRequest;
          if (mode === "unknown") mode = "ndjson";
        } catch {
          // ignore malformed lines
        }
      }
    }
  }
}

/**
 * Try to parse one Content-Length-framed message from the buffer (legacy).
 */
function tryParseContentLength(
  buf: Buffer
): { message: JsonRpcRequest; consumed: number } | null {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep === -1) return null;

  const headerStr = buf.slice(0, sep).toString("utf-8");
  let contentLength = 0;
  for (const line of headerStr.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === "content-length") {
      contentLength = parseInt(line.slice(colon + 1).trim(), 10);
    }
  }
  if (isNaN(contentLength) || contentLength <= 0) return null;

  const bodyStart = sep + 4;
  if (buf.length < bodyStart + contentLength) return null;

  const body = buf.slice(bodyStart, bodyStart + contentLength).toString("utf-8");
  return { message: JSON.parse(body) as JsonRpcRequest, consumed: bodyStart + contentLength };
}

/**
 * Send a JSON-RPC response as NDJSON (one JSON line + newline).
 * Claude Code ≥2.1.80 expects this format.
 */
export function sendMessage(payload: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}
