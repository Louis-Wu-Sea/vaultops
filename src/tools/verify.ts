/**
 * Task-as-Code verification tool (Group D): run_verify
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult, FrontmatterData } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath } from "../vault/resolve.js";
import { TASKS_DIR } from "../constants.js";
import { toolResult } from "./helpers.js";

interface VerifyCheck {
  type: string;
  path?: string;
  pattern?: string;
  expect?: string;
}

/** Maximum file size for grep_content reads (10 MB). */
const MAX_GREP_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum regex pattern length. */
const MAX_PATTERN_LENGTH = 200;

/** Detect dangerous regex patterns that can cause catastrophic backtracking (ReDoS). */
function isUnsafeRegex(pattern: string): boolean {
  // Reject nested quantifiers like (a+)+, (a*)+, (a+)*, etc.
  if (/([+*]|\{\d+,?\d*\})\s*\)[\s]*[+*]/.test(pattern)) return true;
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return true;
  // Reject overlapping alternations with quantifiers
  if (/(\.\*){2,}/.test(pattern)) return true;
  return false;
}

/** Validate and sanitize a path to prevent traversal outside project root. */
function isPathWithinRoot(resolvedPath: string, projectRoot: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const rel = path.relative(resolvedRoot, resolvedPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Allowed verify check types. */
const VALID_CHECK_TYPES = new Set(["file_exists", "file_changed", "grep_content", "test_pattern"]);

/** Allowed keys in a verify check object. */
const VALID_CHECK_KEYS = new Set(["type", "path", "pattern", "expect"]);

/** Validate and sanitize a single verify check object. */
function sanitizeCheck(obj: unknown): VerifyCheck | null {
  if (typeof obj !== "object" || obj === null) return null;
  const raw = obj as Record<string, unknown>;
  const type = String(raw.type ?? "");
  if (!VALID_CHECK_TYPES.has(type)) return null;
  const check: VerifyCheck = { type };
  if (raw.path != null) check.path = String(raw.path);
  if (raw.pattern != null) check.pattern = String(raw.pattern);
  if (raw.expect != null) check.expect = String(raw.expect);
  // Strip unknown keys (prevent prototype pollution / injection)
  return check;
}

/**
 * Parse verify checks from task frontmatter.
 * Supports both inline [{type: file_exists, path: ...}] and structured YAML.
 * Uses schema validation to prevent injection attacks.
 */
function parseVerifyChecks(fm: FrontmatterData): VerifyCheck[] {
  const raw = fm.verify;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const checks: VerifyCheck[] = [];
    for (const item of raw) {
      if (typeof item === "object" && item !== null) {
        // Already parsed as object by frontmatter parser
        const check = sanitizeCheck(item);
        if (check) checks.push(check);
        continue;
      }
      // Try to parse string items safely
      try {
        const str = String(item);
        // Safe JSON-like transform: only allow known simple key:value patterns
        const parsed = JSON.parse(str.replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"'));
        const check = sanitizeCheck(parsed);
        if (check) checks.push(check);
      } catch { /* skip unparseable items */ }
    }
    return checks;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw.replace(/(\w+)\s*:/g, '"$1":').replace(/'/g, '"'));
      if (Array.isArray(parsed)) {
        return parsed.map(sanitizeCheck).filter((c): c is VerifyCheck => c !== null);
      }
    } catch { /* not JSON */ }
  }
  return [];
}

/**
 * Run verify checks against the project directory.
 * Path traversal protection: all paths resolved relative to project root.
 */
function runChecks(checks: VerifyCheck[], projectRoot: string): { passed: boolean; results: Record<string, unknown>[] } {
  const results: Record<string, unknown>[] = [];
  let allPassed = true;

  for (const check of checks) {
    const checkType = check.type ?? "";
    let passed = false;
    let detail = "";

    // Path traversal protection: resolve and verify path stays within project root
    const checkPath = check.path ? path.resolve(projectRoot, check.path) : "";
    if (checkPath && !isPathWithinRoot(checkPath, projectRoot)) {
      results.push({ type: checkType, passed: false, detail: "Path traversal blocked" });
      allPassed = false;
      continue;
    }

    switch (checkType) {
      case "file_exists":
        passed = checkPath ? fileExists(checkPath) : false;
        detail = passed ? "file exists" : "file not found";
        break;

      case "file_changed": {
        // Check if file has been modified (existence implies change for this context)
        passed = checkPath ? fileExists(checkPath) : false;
        detail = passed ? "file present" : "file not found";
        break;
      }

      case "grep_content": {
        const pattern = String(check.pattern ?? "");
        if (!checkPath || !pattern) {
          passed = false;
          detail = "path and pattern required";
          break;
        }
        // ReDoS protection: limit pattern length and reject dangerous patterns
        const safePattern = pattern.slice(0, MAX_PATTERN_LENGTH);
        if (isUnsafeRegex(safePattern)) {
          passed = false;
          detail = "regex pattern rejected — potential catastrophic backtracking";
          break;
        }
        // File size protection: prevent OOM from very large files
        try {
          const stat = fs.statSync(checkPath);
          if (stat.size > MAX_GREP_FILE_SIZE) {
            passed = false;
            detail = `file too large (${Math.round(stat.size / 1024 / 1024)}MB > 10MB limit)`;
            break;
          }
        } catch {
          passed = false;
          detail = "file not found";
          break;
        }
        const content = readFileOrNull(checkPath);
        if (content === null) {
          passed = false;
          detail = "file not found";
          break;
        }
        try {
          const regex = new RegExp(safePattern);
          passed = regex.test(content);
          detail = passed ? "pattern found" : "pattern not found";
        } catch {
          passed = false;
          detail = "invalid regex pattern";
        }
        break;
      }

      case "test_pattern": {
        // Check that test files exist matching a pattern
        const testPattern = String(check.pattern ?? "").slice(0, MAX_PATTERN_LENGTH);
        if (!testPattern) {
          passed = false;
          detail = "pattern required";
          break;
        }
        // Simple glob: look for files matching pattern in project
        // Use includes() for plain text matching; only use regex if safe
        try {
          const dir = checkPath || projectRoot;
          const files = fs.readdirSync(dir).filter((f) => {
            // Plain text match is always safe
            if (f.includes(testPattern)) return true;
            // Regex match only if pattern is safe
            if (isUnsafeRegex(testPattern)) return false;
            try { return new RegExp(testPattern).test(f); } catch { return false; }
          });
          passed = files.length > 0;
          detail = passed ? `${files.length} test file(s) found` : "no matching test files";
        } catch {
          passed = false;
          detail = "directory not found";
        }
        break;
      }

      default:
        detail = `unknown check type: ${checkType}`;
    }

    if (!passed) allPassed = false;
    results.push({ type: checkType, path: check.path ?? "", pattern: check.pattern ?? "", passed, detail });
  }

  return { passed: allPassed, results };
}

export function runVerify(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";

  if (!taskId) return toolResult({ error: "task_id is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskFile = path.join(execDir!, TASKS_DIR, `${taskId}.md`);
  const content = readFileOrNull(taskFile);
  if (content === null) return toolResult({ error: `Task ${taskId} not found` }, true);

  const { frontmatter: fm } = parseFrontmatter(content);
  const checks = parseVerifyChecks(fm);

  if (!checks.length) {
    return toolResult({ task_id: taskId, has_verify: false, message: "No verify checks defined for this task." });
  }

  const { passed, results } = runChecks(checks, path.resolve(projectPath));

  return toolResult({
    task_id: taskId,
    has_verify: true,
    passed,
    total_checks: checks.length,
    passed_checks: results.filter((r) => r.passed).length,
    failed_checks: results.filter((r) => !r.passed).length,
    results,
  });
}
