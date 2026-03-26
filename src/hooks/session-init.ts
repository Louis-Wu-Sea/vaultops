/**
 * VaultOps Brain — SessionStart hook.
 *
 * Fires on session startup/resume/clear/compact.
 * Initializes session state and loads any active IN_PROGRESS task from the vault.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isVaultopsProject, getDefaultState, saveState } from "./shared/brain-state.js";
import { getContext } from "../tools/core.js";
import { execPath, resolveVaultProject } from "../vault/resolve.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { SPRINTS_DIR } from "../constants.js";
import { getSyncConfig, getLastSyncStatus, hasGitRepo } from "../sync.js";

function main(): void {
  const projectPath = process.cwd();

  if (!isVaultopsProject(projectPath)) return;

  // Initialize fresh state
  const state = getDefaultState();
  state.session_start = new Date().toISOString();

  // Load current vault context to find active tasks
  let data: Record<string, unknown> = {};
  try {
    const result = getContext({ project_path: projectPath });
    const content = result.content as Array<{ text?: string }>;
    if (content?.[0]?.text) {
      data = JSON.parse(content[0].text);
    }
  } catch { /* ignore */ }

  const activeTasks = (data.active_tasks ?? []) as Array<Record<string, string>>;
  const taskSummary = (data.task_summary ?? {}) as Record<string, number>;

  const lines: string[] = [];

  // Active task — primary context
  if (activeTasks.length) {
    const focus = activeTasks[0];
    state.active_task_id = focus.id;
    state.phase = "working";
    const extra = activeTasks.length > 1 ? ` (+${activeTasks.length - 1} more)` : "";
    lines.push(`[VaultOps] ${focus.id}: ${focus.task}${extra}`);
  }

  const total = taskSummary.total ?? 0;
  const done = taskSummary.done ?? 0;

  // Urgent items only (blocked tasks, sprint deadline ≤ 3 days, sync conflicts)
  const urgentParts: string[] = [];

  const blocked = (data.blocked_tasks ?? []) as unknown[];
  if (blocked.length) urgentParts.push(`${blocked.length} blocked`);

  // Sprint deadline — only if within 3 days
  try {
    const [execDir, err] = execPath(projectPath);
    if (!err && execDir) {
      const sprintsPath = path.join(execDir, SPRINTS_DIR);
      if (fs.existsSync(sprintsPath) && fs.statSync(sprintsPath).isDirectory()) {
        const today = new Date().toISOString().slice(0, 10);
        const threeDays = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
        for (const fname of fs.readdirSync(sprintsPath)) {
          if (fname.startsWith("Sprint-") && fname.endsWith(".md") && !fname.includes("Retro")) {
            const sc = readFileOrNull(path.join(sprintsPath, fname)) ?? "";
            const { frontmatter: sfm } = parseFrontmatter(sc);
            const endDate = String(sfm.end_date ?? "");
            const sprintNum = String(sfm.number ?? fname.replace("Sprint-", "").replace(".md", ""));
            if (endDate && endDate <= threeDays) {
              const retroFile = path.join(execDir, SPRINTS_DIR, `Sprint-${sprintNum}-Retro.md`);
              if (!fileExists(retroFile)) {
                urgentParts.push(`Sprint ${sprintNum} ends ${endDate}`);
              }
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Sync conflicts only (not routine sync status)
  try {
    const syncCfg = getSyncConfig(projectPath);
    const vaultProject = resolveVaultProject(projectPath);
    if (syncCfg.enabled && vaultProject && hasGitRepo(vaultProject)) {
      const status = getLastSyncStatus(projectPath, vaultProject);
      if (status.hasConflicts) {
        urgentParts.push("sync conflicts — see Conflict Report.md");
      }
    }
  } catch { /* ignore */ }

  if (urgentParts.length) {
    lines.push(`[!] ${urgentParts.join(" · ")}`);
  }

  if (!activeTasks.length) {
    if (total) {
      lines.push(`[VaultOps] ${done}/${total} tasks done. Auto-tracking active.`);
    } else {
      lines.push("[VaultOps] Auto-tracking active.");
    }
  }

  saveState(projectPath, state);

  process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }) + "\n");
}

main();
