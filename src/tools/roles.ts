/**
 * Role enrichment tools (Group C): get_task, write_role_output, get_role_output
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult, RoleName } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseTaskBoard } from "../fs/markdown-table.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath, resolveVaultProject } from "../vault/resolve.js";
import { TASK_BOARD, ROLE_OUTPUTS_DIR, EXEC_JOURNAL, VALID_ROLES } from "../constants.js";
import { toolResult, receiptResult, vaultStats, impactReceipt, autoCommitIfDocRepo } from "./helpers.js";

export function getTask(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";

  if (!taskId) return toolResult({ error: "task_id is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return toolResult({ error: `Task ${taskId} not found in Task Board` }, true);

  const roleOutputsDir = path.join(execDir!, ROLE_OUTPUTS_DIR, taskId);
  const roleOutputs: Record<string, Record<string, unknown>> = {};

  try {
    if (fs.statSync(roleOutputsDir).isDirectory()) {
      for (const role of VALID_ROLES) {
        const roleFile = path.join(roleOutputsDir, `${role}.md`);
        const content = readFileOrNull(roleFile);
        if (content !== null) {
          const { frontmatter, body } = parseFrontmatter(content);
          roleOutputs[role] = {
            status: frontmatter.status ?? "unknown",
            updated_at: frontmatter.updated_at ?? "",
            content: body.trim(),
          };
        }
      }
    }
  } catch { /* dir doesn't exist */ }

  const completedRoles = VALID_ROLES.filter(
    (r) => r in roleOutputs && roleOutputs[r].status === "complete"
  );
  const nextRole = VALID_ROLES.find((r) => !completedRoles.includes(r)) ?? null;

  return toolResult({ task, role_outputs: roleOutputs, completed_roles: completedRoles, next_role: nextRole });
}

export function writeRoleOutput(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";
  const role = (args.role as string) || "";
  const content = (args.content as string) || "";

  if (!taskId) return toolResult({ error: "task_id is required" }, true);
  if (!role || !VALID_ROLES.includes(role as RoleName)) {
    return toolResult({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }, true);
  }
  if (!content) return toolResult({ error: "content is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return toolResult({ error: `Task ${taskId} not found in Task Board` }, true);

  const now = new Date().toISOString();
  const fileContent = `---
role: ${role}
task_id: ${taskId}
status: complete
updated_at: ${now}
tags: [vaultops/role-output, vaultops/role/${role.toLowerCase()}, vaultops/task/${taskId}]
---

${content}
`;

  const filepath = path.join(execDir!, ROLE_OUTPUTS_DIR, taskId, `${role}.md`);
  atomicWrite(filepath, fileContent);

  // Auto-log
  const journalPath = path.join(execDir!, EXEC_JOURNAL);
  const dateStr = now.slice(0, 10);
  const entry = `\n## ${dateStr} — ${role} output written for ${taskId}\n- Logged: ${now}\n`;
  const existing = readFileOrNull(journalPath) ?? "";
  atomicWrite(journalPath, existing + entry);

  const data: Record<string, unknown> = { written: true, task_id: taskId, role, file: filepath, updated_at: now };

  const vaultProject = resolveVaultProject(projectPath);
  if (vaultProject) {
    const sha = autoCommitIfDocRepo(vaultProject, `vault: ${role} output for ${taskId}`);
    if (sha) data.auto_commit = sha;
  }

  try {
    const stats = vaultStats(execDir!);
    const rolesDone = VALID_ROLES.map((r) =>
      fileExists(path.join(execDir!, ROLE_OUTPUTS_DIR, taskId, `${r}.md`)) ? `${r} ✓` : `${r} ○`
    );
    const chain = rolesDone.join("  ·  ");
    const taskTitle = task.task.slice(0, 30);
    return receiptResult(
      impactReceipt(`${role} output saved`, [`${taskId}  ·  ${taskTitle}`, chain], stats),
      data,
    );
  } catch {
    return toolResult(data);
  }
}

export function getRoleOutput(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";
  const role = (args.role as string) || "";

  if (!taskId) return toolResult({ error: "task_id is required" }, true);
  if (!role || !VALID_ROLES.includes(role as RoleName)) {
    return toolResult({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const filepath = path.join(execDir!, ROLE_OUTPUTS_DIR, taskId, `${role}.md`);
  const raw = readFileOrNull(filepath);
  if (raw === null) {
    return toolResult({ exists: false, task_id: taskId, role, content: null });
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  return toolResult({
    exists: true,
    task_id: taskId,
    role,
    status: frontmatter.status ?? "unknown",
    updated_at: frontmatter.updated_at ?? "",
    content: body.trim(),
  });
}
