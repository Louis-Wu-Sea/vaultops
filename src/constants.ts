/**
 * All string constants for VaultOps.
 * Ported from vaultops_mcp_server.py lines 28-71.
 */

import * as os from "node:os";
import * as path from "node:path";

// ── Registry paths ─────────────────────────────────────────────────────

export const PROJECTS_JSON = path.resolve(
  process.env.VAULTOPS_PROJECTS_JSON ?? path.join(os.homedir(), ".vaultops", "state", "projects.json"),
);

export const REPOS_JSON = path.resolve(
  process.env.VAULTOPS_REPOS_JSON ?? path.join(os.homedir(), ".vaultops", "state", "repos.json"),
);

// ── Meeting constants ──────────────────────────────────────────────────

export const MEETINGS_DIR = "_meetings";
export const MEETING_INDEX = "Meeting Index.md";
export const MEETING_NOTES_DIR = "Notes";
export const MEETING_SERIES_DIR = "Series";
export const MEETING_TEMPLATES_DIR = "Templates";

// ── Execution directory ────────────────────────────────────────────────

export const EXEC_DIR = "08-Execution";
export const TASK_BOARD = "Task Board.md";
export const WORK_PLANS = "Work Plans.md";
export const EXEC_JOURNAL = "Execution Journal.md";
export const CURRENT_STAGE = "Current Stage.md";
export const CONTEXT_STATE = "Context State.md";
export const ROLE_OUTPUTS_DIR = "Role Outputs";
export const TASKS_DIR = "Tasks";
export const SPRINTS_DIR = "Sprints";

// ── Roles ──────────────────────────────────────────────────────────────

import type { RoleName } from "./types.js";

export const VALID_ROLES: readonly RoleName[] = [
  "BA",
  "Designer",
  "SystemAnalyst",
  "Developer",
  "QA",
] as const;

export const ROLE_ORDER: Record<RoleName, number> = {
  BA: 0,
  Designer: 1,
  SystemAnalyst: 2,
  Developer: 3,
  QA: 4,
};

// ── Documentation sections ─────────────────────────────────────────────

export const DOC_SECTIONS = [
  "00-Overview",
  "01-Requirements",
  "02-Architecture",
  "03-Design",
  "04-Development",
  "05-QA",
  "06-Operations",
  "07-References",
  "09-Interfaces",
  "10-Security",
  "11-Marketing",
] as const;

/** Legacy section names that should be auto-renamed to canonical. */
export const SECTION_RENAMES: Record<string, string> = {
  "02-Research": "02-Architecture",
};

// ── Git sync ───────────────────────────────────────────────────────────

/** Config key: sync enabled/disabled */
export const CFG_GIT_SYNC = "VAULTOPS_GIT_SYNC";
/** Config key: personal | team */
export const CFG_GIT_SYNC_MODE = "VAULTOPS_GIT_SYNC_MODE";
/** Config key: session | hourly | daily | manual */
export const CFG_GIT_SYNC_SCHEDULE = "VAULTOPS_GIT_SYNC_SCHEDULE";
/** Config key: auto-ours | notify */
export const CFG_GIT_CONFLICT_STRATEGY = "VAULTOPS_GIT_CONFLICT_STRATEGY";
/** Config key: git branch (default: main) */
export const CFG_GIT_BRANCH = "VAULTOPS_GIT_BRANCH";
/** Config key: git remote URL (stored for reference only, no credentials) */
export const CFG_GIT_REMOTE = "VAULTOPS_GIT_REMOTE";

// ── Impact receipts ────────────────────────────────────────────────────

export const RECEIPT_WIDTH = 43;
export const RECEIPT_SEP = "━".repeat(RECEIPT_WIDTH);
