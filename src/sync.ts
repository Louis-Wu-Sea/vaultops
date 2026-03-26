/**
 * Autonomous git sync engine for VaultOps vaults.
 *
 * Supports Personal (auto-ours) and Team (union merge + notify) modes.
 * Reads sync config from the project's .vaultops/config.env.
 * All git operations use execFileSync/spawnSync — no shell injection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { readFileOrNull } from "./fs/read.js";
import { atomicWrite } from "./fs/write.js";
import { readConfigEnv } from "./vault/config.js";
import { EXEC_DIR } from "./constants.js";

// ── Constants ──────────────────────────────────────────────────────────

export const SYNC_LOG = "Sync Log.md";
export const CONFLICT_REPORT = "Conflict Report.md";

/** .gitattributes content written for Team mode vaults. */
export const TEAM_GITATTRIBUTES = `# VaultOps — append-only files always union-merge (keep both sides)
08-Execution/Execution Journal.md  merge=union
08-Execution/Sync Log.md           merge=union
08-Execution/Task Board.md         merge=union
_meetings/**                       merge=union
`;

// ── Types ──────────────────────────────────────────────────────────────

export interface SyncConfig {
  enabled: boolean;
  mode: "personal" | "team";
  schedule: "session" | "hourly" | "daily" | "manual";
  conflictStrategy: "auto-ours" | "notify";
  branch: string;
  remote: string;
}

export interface SyncOptions {
  vaultPath: string;
  conflictStrategy: "auto-ours" | "notify";
  branch: string;
  mode: "personal" | "team";
  userIdentity?: string;
}

export interface SyncResult {
  skipped: boolean;
  committed: boolean;
  pushed: boolean;
  conflicts: boolean;
  conflictFiles: string[];
  commitSha?: string;
  error?: string;
  durationMs: number;
  remote: string;
}

export interface SyncStatus {
  lastSyncAt?: string;
  lastStatus?: string;
  pendingChanges: number;
  hasConflicts: boolean;
  remote: string;
  schedule: string;
  mode: string;
  enabled: boolean;
}

// ── Config helpers ─────────────────────────────────────────────────────

/**
 * Read sync config from project's .vaultops/config.env.
 */
export function getSyncConfig(projectPath: string): SyncConfig {
  const config = readConfigEnv(projectPath);
  return {
    enabled: config.VAULTOPS_GIT_SYNC === "enabled",
    mode: ((config.VAULTOPS_GIT_SYNC_MODE ?? "personal") as "personal" | "team"),
    schedule: ((config.VAULTOPS_GIT_SYNC_SCHEDULE ?? "manual") as SyncConfig["schedule"]),
    conflictStrategy: ((config.VAULTOPS_GIT_CONFLICT_STRATEGY ?? "notify") as "auto-ours" | "notify"),
    branch: config.VAULTOPS_GIT_BRANCH ?? "main",
    remote: config.VAULTOPS_GIT_REMOTE ?? "",
  };
}

/**
 * Check if vault directory has a .git repo.
 */
export function hasGitRepo(vaultPath: string): boolean {
  try {
    return fs.statSync(path.join(vaultPath, ".git")).isDirectory();
  } catch {
    return false;
  }
}

// ── User identity ──────────────────────────────────────────────────────

export function getGitUserIdentity(vaultPath: string): string {
  try {
    const name = child_process.execFileSync("git", ["config", "user.name"], {
      cwd: vaultPath, timeout: 5000, encoding: "utf-8",
    }).trim();
    const host = os.hostname().split(".")[0];
    return name ? `${name}@${host}` : host;
  } catch {
    return os.hostname().split(".")[0];
  }
}

// ── Section dir discovery ──────────────────────────────────────────────

function discoverSectionDirs(vaultPath: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of fs.readdirSync(vaultPath, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{2}-/.test(entry.name)) dirs.push(entry.name);
    }
  } catch { /* ignore */ }
  return dirs;
}

// ── Sync log ───────────────────────────────────────────────────────────

function appendSyncLog(vaultPath: string, result: SyncResult): void {
  const logPath = path.join(vaultPath, EXEC_DIR, SYNC_LOG);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const remoteShort = result.remote
    ? result.remote
        .replace(/^https?:\/\//, "")
        .replace(/^git@/, "")
        .replace(/:/, "/")
        .replace(/\.git$/, "")
    : "\u2014";

  let statusIcon: string;
  if (result.error) statusIcon = "\u2717 error";
  else if (result.conflicts) statusIcon = "\u26a0 conflict";
  else if (result.skipped) statusIcon = "\u2013 skipped";
  else if (result.pushed) statusIcon = "\u2713 pushed";
  else statusIcon = "\u2713 committed";

  const durationStr = result.durationMs > 0 ? `${(result.durationMs / 1000).toFixed(1)}s` : "\u2014";
  const sha = result.commitSha ? result.commitSha.slice(0, 7) : "\u2014";
  const row = `| ${now} | ${statusIcon} | ${sha} | ${remoteShort} | ${durationStr} |\n`;

  if (!fs.existsSync(logPath)) {
    const header = `# Sync Log\n\n| Date | Status | Commit | Remote | Duration |\n| ---- | ------ | ------ | ------ | -------- |\n`;
    atomicWrite(logPath, header + row);
  } else {
    const existing = readFileOrNull(logPath) ?? "";
    atomicWrite(logPath, existing + row);
  }
}

// ── Conflict report ────────────────────────────────────────────────────

function writeConflictReport(vaultPath: string, conflictFiles: string[]): void {
  const reportPath = path.join(vaultPath, EXEC_DIR, CONFLICT_REPORT);
  const now = new Date().toISOString();
  const fileList = conflictFiles.length
    ? conflictFiles.map(f => `- ${f}`).join("\n")
    : "- (check git status for details)";

  const content = `---\nreported_at: ${now}\nstrategy: notify\n---\n\n# Conflict Report\n\nGit rebase detected conflicts in the following files:\n\n${fileList}\n\n## Resolution\n\n1. Open each conflicting file and resolve <<<<<<< / >>>>>>> markers\n2. Stage resolved files: \`git add <file>\`\n3. Continue rebase: \`git rebase --continue\`\n4. Then run: \`vaultops sync now\`\n\nOr to discard remote changes and keep local: \`git rebase --abort\`\n`;
  atomicWrite(reportPath, content);
}

// ── Core sync engine ───────────────────────────────────────────────────

export function syncVault(opts: SyncOptions): SyncResult {
  const { vaultPath, conflictStrategy, branch, mode } = opts;
  const startMs = Date.now();

  const result: SyncResult = {
    skipped: false,
    committed: false,
    pushed: false,
    conflicts: false,
    conflictFiles: [],
    durationMs: 0,
    remote: "",
  };

  // Validate branch name (prevents argument injection)
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    result.error = `Invalid branch name: ${branch}`;
    result.durationMs = Date.now() - startMs;
    return result;
  }

  if (!hasGitRepo(vaultPath)) {
    result.error = "No git repository in vault. Run 'vaultops sync setup' first.";
    result.durationMs = Date.now() - startMs;
    return result;
  }

  // Resolve remote for logging
  try {
    const remoteOut = child_process.execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: vaultPath, timeout: 5000, encoding: "utf-8",
    });
    result.remote = remoteOut.trim();
  } catch { /* no remote */ }

  try {
    // 1. Check for uncommitted changes
    const statusOut = child_process.execFileSync("git", ["status", "--porcelain"], {
      cwd: vaultPath, timeout: 10000, encoding: "utf-8",
    });

    if (!statusOut.trim()) {
      result.skipped = true;
    } else {
      // 2. Stage vault-specific directories only
      const vaultDirs = [EXEC_DIR, ...discoverSectionDirs(vaultPath), "_meetings", "_shared"];
      for (const vd of vaultDirs) {
        const vdPath = path.join(vaultPath, vd);
        try {
          if (fs.statSync(vdPath).isDirectory()) {
            child_process.execFileSync("git", ["add", vd], { cwd: vaultPath, timeout: 10000 });
          }
        } catch { /* skip missing dirs */ }
      }

      // 3. Check if anything staged
      const diff = child_process.spawnSync("git", ["diff", "--cached", "--quiet"], {
        cwd: vaultPath, timeout: 10000,
      });

      if (diff.status === 0) {
        result.skipped = true;
      } else {
        // 4. Commit
        const now = new Date().toISOString().slice(0, 16).replace("T", " ");
        const identity = mode === "team" && opts.userIdentity ? ` [${opts.userIdentity}]` : "";
        const commitMsg = `vault: sync ${now}${identity}`;

        const commit = child_process.spawnSync("git", ["commit", "-m", commitMsg], {
          cwd: vaultPath, timeout: 15000, encoding: "utf-8",
        });

        if (commit.status === 0) {
          result.committed = true;
          try {
            const log = child_process.execFileSync("git", ["log", "--format=%H", "-1"], {
              cwd: vaultPath, timeout: 5000, encoding: "utf-8",
            });
            result.commitSha = log.trim() || undefined;
          } catch { /* ignore */ }
        }
      }
    }

    // 5. Pull with rebase (only if remote is configured)
    if (result.remote) {
      const pull = child_process.spawnSync(
        "git", ["pull", "--rebase", "origin", branch],
        { cwd: vaultPath, timeout: 30000, encoding: "utf-8" },
      );

      if (pull.status !== 0) {
        const conflictStatus = child_process.spawnSync("git", ["status", "--porcelain"], {
          cwd: vaultPath, timeout: 10000, encoding: "utf-8",
        });
        const conflictFiles = (conflictStatus.stdout?.toString() ?? "")
          .split("\n")
          .filter(l => /^(UU|AA|DD|AU|UA)/.test(l))
          .map(l => l.slice(3).trim())
          .filter(Boolean);

        result.conflicts = true;
        result.conflictFiles = conflictFiles;

        if (conflictStrategy === "auto-ours") {
          let allResolved = conflictFiles.length > 0;
          for (const f of conflictFiles) {
            const checkout = child_process.spawnSync("git", ["checkout", "--ours", f], {
              cwd: vaultPath, timeout: 10000,
            });
            if (checkout.status === 0) {
              child_process.spawnSync("git", ["add", f], { cwd: vaultPath, timeout: 5000 });
            } else {
              allResolved = false;
            }
          }

          if (allResolved && conflictFiles.length > 0) {
            const cont = child_process.spawnSync("git", ["rebase", "--continue"], {
              cwd: vaultPath, timeout: 15000,
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            if (cont.status === 0) {
              result.conflicts = false;
            } else {
              child_process.spawnSync("git", ["rebase", "--abort"], { cwd: vaultPath, timeout: 10000 });
              result.error = "Auto-resolve failed — resolve conflicts manually";
            }
          } else {
            child_process.spawnSync("git", ["rebase", "--abort"], { cwd: vaultPath, timeout: 10000 });
          }
        } else {
          child_process.spawnSync("git", ["rebase", "--abort"], { cwd: vaultPath, timeout: 10000 });
          writeConflictReport(vaultPath, conflictFiles);
        }
      }

      // 6. Push (only if no unresolved conflicts)
      if (!result.conflicts && !result.error) {
        const push = child_process.spawnSync("git", ["push", "origin", branch], {
          cwd: vaultPath, timeout: 30000, encoding: "utf-8",
        });
        if (push.status === 0) {
          result.pushed = true;
        } else {
          const stderr = (push.stderr as Buffer | string | undefined)?.toString() ?? "";
          result.error = `Push failed: ${stderr.slice(0, 200)}`;
        }
      }
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - startMs;

  try {
    appendSyncLog(vaultPath, result);
  } catch { /* never surface log errors */ }

  return result;
}

// ── Status reader ──────────────────────────────────────────────────────

export function getLastSyncStatus(projectPath: string, vaultPath: string): SyncStatus {
  const config = getSyncConfig(projectPath);
  const status: SyncStatus = {
    pendingChanges: 0,
    hasConflicts: false,
    remote: config.remote,
    schedule: config.schedule,
    mode: config.mode,
    enabled: config.enabled,
  };

  if (!hasGitRepo(vaultPath)) return status;

  try {
    const out = child_process.execFileSync("git", ["status", "--porcelain"], {
      cwd: vaultPath, timeout: 10000, encoding: "utf-8",
    });
    status.pendingChanges = out.trim() ? out.trim().split("\n").length : 0;
  } catch { /* no git */ }

  status.hasConflicts = fs.existsSync(path.join(vaultPath, EXEC_DIR, CONFLICT_REPORT));

  const logPath = path.join(vaultPath, EXEC_DIR, SYNC_LOG);
  if (fs.existsSync(logPath)) {
    const logContent = readFileOrNull(logPath) ?? "";
    const dataLines = logContent
      .split("\n")
      .filter(l => l.startsWith("|") && !l.includes("Date") && !l.includes("----") && l.trim() !== "|");
    if (dataLines.length > 0) {
      const lastLine = dataLines[dataLines.length - 1];
      const cols = lastLine.split("|").map(c => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        status.lastSyncAt = cols[0];
        status.lastStatus = cols[1];
      }
    }
  }

  return status;
}
