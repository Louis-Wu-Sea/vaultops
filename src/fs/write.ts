/**
 * Atomic file write — temp file + rename.
 *
 * Ported from Python's _atomic_write() (lines 426-440).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

/**
 * Write file atomically via temp file + rename.
 * Creates parent directories automatically.
 */
export function atomicWrite(filePath: string, content: string): void {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });

  const tmpName = `.vaultops-${crypto.randomBytes(8).toString("hex")}.tmp`;
  const tmpPath = path.join(dirPath, tmpName);

  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o644 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Append content to a file. Creates file if it doesn't exist.
 */
export function appendToFile(filePath: string, content: string): void {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.appendFileSync(filePath, content, "utf-8");
}
