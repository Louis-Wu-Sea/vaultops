/**
 * VaultOps Brain — PreToolUse hook.
 *
 * Fires before Edit/Write/Bash tools. Injects task context, tracks files
 * in session state, and detects architecture-relevant changes that need
 * doc updates.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as re from "node:path"; // for basename only
import {
  isVaultopsProject,
  loadState,
  saveState,
  isArchitectureFile,
  predictRisk,
  getFileHistory,
  type BrainState,
} from "./shared/brain-state.js";
import { getContext } from "../tools/core.js";
import { resolveVaultProject } from "../vault/resolve.js";

function main(): void {
  const projectPath = process.cwd();

  if (!isVaultopsProject(projectPath)) return;

  // Read hook input from stdin
  let hookInput: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    hookInput = JSON.parse(raw);
  } catch {
    hookInput = {};
  }

  const toolName = String(hookInput.tool_name ?? "");
  const toolInput = (hookInput.tool_input ?? {}) as Record<string, string>;

  const state = loadState(projectPath);

  // If suppressed, skip all tracking
  if (state.suppressed) return;

  const now = new Date().toISOString();

  // Track what's about to happen
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = toolInput.file_path ?? "";
    if (filePath) {
      const entry = { path: filePath, timestamp: now };
      if (toolName === "Edit") {
        if (!state.files_edited.some(e => e.path === filePath)) {
          state.files_edited.push(entry);
        }
      } else {
        if (!state.files_created.some(e => e.path === filePath)) {
          state.files_created.push(entry);
        }
      }

      // Architecture detection
      if (isArchitectureFile(filePath) && !state.docs_touched.includes(filePath)) {
        state.docs_touched.push(filePath);
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command ?? "";
    if (command) {
      // Redact potential secrets before logging
      const sanitized = command
        .replace(/(?:--|=)\s*(?:sk-|ghp_|gho_|glpat-|xoxb-|xoxp-)\S+/g, "***REDACTED***")
        .replace(/(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)\s*[=:]\s*\S+/gi, "$1=***REDACTED***")
        .slice(0, 100);
      state.bash_commands_summary.push({ summary: sanitized, timestamp: now });
    }
  }

  // Update phase if we were idle and now tracking files
  if (state.phase === "idle" && (state.files_edited.length || state.files_created.length)) {
    state.phase = "working";
  }

  saveState(projectPath, state);

  // Build context output
  const lines: string[] = [];

  // Inject current task context
  try {
    const result = getContext({ project_path: projectPath });
    const content = result.content as Array<{ text?: string }>;
    let data: Record<string, unknown> = {};
    if (content?.[0]?.text) data = JSON.parse(content[0].text);

    const active = (data.active_tasks ?? []) as Array<Record<string, string>>;
    const blocked = (data.blocked_tasks ?? []) as unknown[];
    const summary = (data.task_summary ?? {}) as Record<string, number>;

    if (active.length) {
      const focus = active[0];
      lines.push(`[VaultOps] Active: ${focus.id} \u2014 ${focus.task} [${focus.priority ?? ""}]`);
    }
    if ((summary.in_progress ?? 0) > 1) {
      lines.push(`(${summary.in_progress} tasks in progress)`);
    }
    if (blocked.length) {
      lines.push(`\u26a0\ufe0f ${blocked.length} blocked task(s)`);
    }
  } catch { /* ignore */ }

  // Predictive Brain: risk detection on file accumulation
  const editedPaths = state.files_edited.map(e => e.path);
  const createdPaths = state.files_created.map(e => e.path);
  const allPaths = [...editedPaths, ...createdPaths];

  if (allPaths.length === 4 && state.active_task_id && !state.risk_warned) {
    try {
      const risk = predictRisk(projectPath, allPaths);
      if (risk.risk_level === "medium" || risk.risk_level === "high") {
        const riskLevel = String(risk.risk_level).toUpperCase();
        lines.push(`[Predictive Brain] Risk: ${riskLevel}`);
        const reasons = (risk.reasons as string[]) ?? [];
        for (const reason of reasons.slice(0, 3)) {
          lines.push(`  \u00b7 ${reason}`);
        }
        if (risk.recommendation) lines.push(`  \u2192 ${risk.recommendation}`);
        if (risk.risk_level === "high" && state.active_task_id) {
          lines.push(`  \u2192 Consider: /vault:task ${state.active_task_id} verify`);
        }
        state.risk_warned = true;
      }
    } catch { /* ignore */ }
  }

  // Arch Radar: hotspot detection per file
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = toolInput.file_path ?? "";
    if (filePath && !state.hotspot_warned.includes(filePath)) {
      try {
        const history = getFileHistory(projectPath, filePath);
        if (history.count >= 3) {
          const basename = path.basename(filePath);
          const reopenNote = history.reopened ? `, ${history.reopened} reopened` : "";
          lines.push(`[Arch Radar] Hotspot: ${basename} changed in ${history.count} tasks${reopenNote}`);
          state.hotspot_warned.push(filePath);
        }
      } catch { /* ignore */ }
    }
  }

  // Auto-inject doc update instruction for architecture files
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = toolInput.file_path ?? "";
    if (filePath && isArchitectureFile(filePath)) {
      const filename = path.basename(filePath);
      lines.push(`[VaultOps] Architecture file changed: ${filename}`);
      lines.push(
        "You MUST update the relevant Obsidian documentation now using " +
        "mcp__vaultops__* tools (log_step, write_plan, or generate_docs_prompt). " +
        "Update architecture notes in the vault to reflect this change."
      );
    }
  }

  // Meeting awareness: undispatched action items
  if (!state.meeting_warned) {
    try {
      const vaultProject = resolveVaultProject(projectPath);
      if (vaultProject) {
        const vaultRoot = path.dirname(vaultProject);
        const meetingsNotes = path.join(vaultRoot, "_meetings", "Notes");
        if (fs.existsSync(meetingsNotes) && fs.statSync(meetingsNotes).isDirectory()) {
          const today = new Date().toISOString().slice(0, 10);
          const undispatched: string[] = [];
          for (const fname of fs.readdirSync(meetingsNotes)) {
            if (!fname.endsWith(".md")) continue;
            const fpath = path.join(meetingsNotes, fname);
            const head = fs.readFileSync(fpath, "utf-8").slice(0, 1024);
            if (head.includes("action_items_dispatched: false")) {
              const dateM = head.match(/date:\s*(\d{4}-\d{2}-\d{2})/);
              if (dateM && dateM[1] < today) {
                const midM = head.match(/meeting_id:\s*(MTG-\d+)/);
                undispatched.push(midM ? midM[1] : fname);
              }
            }
          }
          if (undispatched.length) {
            lines.push(
              `[Meeting] ${undispatched.length} meeting(s) have undispatched action items: ` +
              `${undispatched.slice(0, 3).join(", ")}. Use /vault:meeting process <ID> to dispatch.`
            );
            state.meeting_warned = true;
          }
        }
      }
    } catch { /* ignore */ }
  }

  saveState(projectPath, state);

  if (lines.length) {
    process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }) + "\n");
  }
}

main();
