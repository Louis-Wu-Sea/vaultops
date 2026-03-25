/**
 * Shared helper functions used by multiple tool handlers.
 *
 * Ported from Python utility functions scattered across the monolith.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import type { ToolResult, VaultStats } from "../types.js";
import { readFileOrNull } from "../fs/read.js";
import { parseTaskBoard } from "../fs/markdown-table.js";
import { readConfigEnv } from "../vault/config.js";
import { TASK_BOARD, EXEC_DIR, MEETINGS_DIR, RECEIPT_SEP } from "../constants.js";

// ── Tool result formatting ─────────────────────────────────────────────

/**
 * Format data as an MCP tool result.
 */
export function toolResult(data: unknown, isError = false): ToolResult {
  const text = typeof data === "object" && data !== null
    ? JSON.stringify(data, null, 2)
    : String(data);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Return a tool result combining a visual receipt with structured data.
 */
export function receiptResult(receipt: string, data: Record<string, unknown>): ToolResult {
  const jsonPart = JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: `${receipt}\n\n${jsonPart}` }] };
}

// ── Vault statistics ───────────────────────────────────────────────────

/**
 * Count tasks and docs for impact receipts.
 */
export function vaultStats(execDir: string): VaultStats {
  const taskBoardMd = readFileOrNull(path.join(execDir, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);

  const stats: VaultStats = { done: 0, active: 0, todo: 0, blocked: 0, total: tasks.length, docs: 0 };

  for (const t of tasks) {
    if (t.status === "DONE") stats.done++;
    else if (t.status === "IN_PROGRESS") stats.active++;
    else if (t.status === "BLOCKED") stats.blocked++;
    else stats.todo++;
  }

  // Count markdown docs in vault
  const vaultRoot = path.dirname(execDir);
  try {
    for (const entry of fs.readdirSync(vaultRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        try {
          for (const f of fs.readdirSync(path.join(vaultRoot, entry.name), { withFileTypes: true })) {
            if (f.name.endsWith(".md")) stats.docs++;
          }
        } catch { /* skip inaccessible dirs */ }
      }
    }
  } catch { /* skip if vault root inaccessible */ }

  return stats;
}

// ── Progress bar ───────────────────────────────────────────────────────

export function progressBar(done: number, total: number, width = 16): string {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ── Impact receipt ─────────────────────────────────────────────────────

export function impactReceipt(action: string, detailLines: string[], stats: VaultStats): string {
  const { done: d, active: a, todo: t, total, docs } = stats;
  const bar = progressBar(d, total);

  const lines = [
    RECEIPT_SEP,
    "⬡  VaultOps",
    RECEIPT_SEP,
    "",
    `  ✦  ${action}`,
  ];

  for (const dl of detailLines) {
    lines.push(`     ${dl}`);
  }

  lines.push(
    "",
    `  ${bar}  ${d}✓  ${a}▶  ${t}○`,
    `  ◈  ${docs} docs across vault`,
    "",
    RECEIPT_SEP,
  );

  return lines.join("\n");
}

// ── Auto-commit for doc repos ──────────────────────────────────────────

/**
 * Discover all NN-* directory names in a vault path.
 */
function discoverAllSectionDirs(vaultPath: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of fs.readdirSync(vaultPath, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{2}-/.test(entry.name)) {
        dirs.push(entry.name);
      }
    }
  } catch { /* ignore */ }
  return dirs;
}

/**
 * If this vault is a doc-repo with granular auto-commit, commit changed files.
 * Returns commit SHA or null.
 *
 * Uses execFileSync (not execSync) to prevent shell injection.
 */
export function autoCommitIfDocRepo(vaultPath: string, message: string): string | null {
  const config = readConfigEnv(vaultPath);
  if (config.VAULTOPS_DOC_REPO !== "true") return null;
  if ((config.VAULTOPS_AUTOCOMMIT ?? "session") !== "granular") return null;

  const gitDir = path.join(vaultPath, ".git");
  try {
    if (!fs.statSync(gitDir).isDirectory()) return null;
  } catch { return null; }

  try {
    // Check for changes — use execFileSync (no shell) for safety
    const status = child_process.execFileSync("git", ["status", "--porcelain"], {
      cwd: vaultPath, timeout: 10000, encoding: "utf-8",
    });
    if (!status.trim()) return null;

    // Stage vault-specific directories
    const vaultDirs = [EXEC_DIR, ...discoverAllSectionDirs(vaultPath), MEETINGS_DIR, "_shared"];
    for (const vd of vaultDirs) {
      const vdPath = path.join(vaultPath, vd);
      try {
        if (fs.statSync(vdPath).isDirectory()) {
          child_process.execFileSync("git", ["add", vd], { cwd: vaultPath, timeout: 10000 });
        }
      } catch { /* skip */ }
    }

    // Check if anything staged
    const diff = child_process.spawnSync("git", ["diff", "--cached", "--quiet"], {
      cwd: vaultPath, timeout: 10000,
    });
    if (diff.status === 0) return null; // nothing staged

    // Commit
    const commit = child_process.spawnSync("git", ["commit", "-m", message], {
      cwd: vaultPath, timeout: 15000, encoding: "utf-8",
    });
    if (commit.status !== 0) return null;

    // Extract SHA
    const log = child_process.execFileSync("git", ["log", "--format=%H", "-1"], {
      cwd: vaultPath, timeout: 5000, encoding: "utf-8",
    });
    return log.trim() || null;
  } catch {
    return null;
  }
}

// ── Verify YAML serialization ──────────────────────────────────────────

/**
 * Serialize verify checks to inline YAML-like format for frontmatter.
 */
export function serializeVerifyYaml(checks: Record<string, unknown>[]): string {
  if (!checks.length) return "[]";
  const parts = checks.map((c) => {
    const items = Object.entries(c)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return `{${items}}`;
  });
  return `[${parts.join(", ")}]`;
}

// ── Task Board header constant ─────────────────────────────────────────

export const TASK_BOARD_HEADER = "| ID | Task | Status | Priority | Owner | Details | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n";
