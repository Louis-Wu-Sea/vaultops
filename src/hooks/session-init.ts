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
import { getReplay } from "../tools/ecosystem.js";
import { execPath } from "../vault/resolve.js";
import { resolveVaultProject } from "../vault/resolve.js";
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

  const lines: string[] = ["[VaultOps Brain \u2014 Active]"];

  if (activeTasks.length) {
    const focus = activeTasks[0];
    state.active_task_id = focus.id;
    state.phase = "working";
    lines.push(`Resuming ${focus.id}: ${focus.task} [${focus.priority ?? ""}]`);
    if (activeTasks.length > 1) lines.push(`(${activeTasks.length} tasks in progress)`);
  } else {
    lines.push("No active task \u2014 will auto-create on first work intent.");
  }

  const blocked = (data.blocked_tasks ?? []) as unknown[];
  if (blocked.length) lines.push(`\u26a0\ufe0f ${blocked.length} blocked task(s)`);

  const total = taskSummary.total ?? 0;
  const done = taskSummary.done ?? 0;
  if (total) lines.push(`Vault: ${done}/${total} tasks done`);

  // Surface learning insight if available
  try {
    const vaultProject = resolveVaultProject(projectPath);
    if (vaultProject) {
      const patternsPath = path.join(vaultProject, "08-Execution", "Learnings", "Patterns.md");
      if (fileExists(patternsPath)) {
        const { frontmatter: pfm } = parseFrontmatter(readFileOrNull(patternsPath) ?? "");
        const conf = pfm.confidence ?? "low";
        const analyzed = pfm.total_tasks_analyzed;
        if ((conf === "medium" || conf === "high") && analyzed) {
          lines.push(`Learning: ${conf} confidence (${analyzed} tasks analyzed)`);
        }
      }
    }
  } catch { /* ignore */ }

  // Auto-Replay: compact digest of recent activity
  try {
    const replay = getReplay({ project_path: projectPath, hours: 24 });
    const content = replay.content as Array<{ text?: string }>;
    if (content?.[0]?.text) {
      for (const segment of content[0].text.split("\n\n")) {
        const s = segment.trim();
        if (s.startsWith("{")) {
          try {
            const rd = JSON.parse(s) as Record<string, number>;
            const parts: string[] = [];
            if (rd.tasks_completed) parts.push(`${rd.tasks_completed} task(s) completed`);
            if (rd.tasks_created) parts.push(`${rd.tasks_created} created`);
            if (rd.stale_docs) parts.push(`${rd.stale_docs} stale doc(s)`);
            if (parts.length) lines.push(`Last 24h: ${parts.join(", ")}`);
            break;
          } catch { continue; }
        }
      }
    }
  } catch { /* ignore */ }

  // Sprint deadline check
  try {
    const [execDir, err] = execPath(projectPath);
    if (!err && execDir) {
      const sprintsPath = path.join(execDir, SPRINTS_DIR);
      if (fs.existsSync(sprintsPath) && fs.statSync(sprintsPath).isDirectory()) {
        const today = new Date().toISOString().slice(0, 10);
        for (const fname of fs.readdirSync(sprintsPath)) {
          if (fname.startsWith("Sprint-") && fname.endsWith(".md") && !fname.includes("Retro")) {
            const sc = readFileOrNull(path.join(sprintsPath, fname)) ?? "";
            const { frontmatter: sfm } = parseFrontmatter(sc);
            const endDate = String(sfm.end_date ?? "");
            const sprintNum = String(sfm.number ?? fname.replace("Sprint-", "").replace(".md", ""));
            if (endDate && endDate <= today) {
              const retroFile = path.join(sprintsPath, `Sprint-${sprintNum}-Retro.md`);
              if (!fileExists(retroFile)) {
                lines.push(`\ud83d\udce2 Sprint ${sprintNum} ended (${endDate}) \u2014 run /vault:retro ${sprintNum}`);
              }
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Git sync status
  try {
    const syncCfg = getSyncConfig(projectPath);
    const vaultProject = resolveVaultProject(projectPath);
    if (syncCfg.enabled && vaultProject && hasGitRepo(vaultProject)) {
      const status = getLastSyncStatus(projectPath, vaultProject);
      if (status.hasConflicts) {
        lines.push(`\u26a0\ufe0f Sync: conflicts unresolved \u2014 see 08-Execution/Conflict Report.md`);
      } else if (status.lastSyncAt) {
        lines.push(`\ud83d\udce1 Last sync: ${status.lastSyncAt} (${status.lastStatus ?? "ok"})`);
      }
      if (status.pendingChanges > 0) {
        lines.push(`${status.pendingChanges} vault file(s) pending sync \u2014 /vault:sync to push`);
      }
    }
  } catch { /* ignore sync status errors */ }

  lines.push('Auto-tracking: tasks, journal, docs. Say "don\'t track" to suppress.');

  saveState(projectPath, state);

  process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }) + "\n");
}

main();
