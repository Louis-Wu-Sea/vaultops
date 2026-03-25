/**
 * Core tool handlers (Group A+B): 8 tools.
 *
 * get_context, get_today, create_task, update_task,
 * log_step, write_plan, get_kanban, generate_docs_prompt
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseTaskBoard, nextTaskId } from "../fs/markdown-table.js";
import { updateFrontmatterField, updateFrontmatterList } from "../fs/frontmatter.js";
import { execPath, resolveVaultProject } from "../vault/resolve.js";
import {
  TASK_BOARD, CURRENT_STAGE, CONTEXT_STATE, EXEC_JOURNAL,
  WORK_PLANS, TASKS_DIR, DOC_SECTIONS, SECTION_RENAMES,
} from "../constants.js";
import {
  toolResult, receiptResult, vaultStats, impactReceipt,
  autoCommitIfDocRepo, serializeVerifyYaml, TASK_BOARD_HEADER,
} from "./helpers.js";

// ── get_context ────────────────────────────────────────────────────────

export function getContext(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const currentStage = readFileOrNull(path.join(execDir!, CURRENT_STAGE)) ?? "";
  const contextState = readFileOrNull(path.join(execDir!, CONTEXT_STATE)) ?? "";
  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);

  const active = tasks.filter((t) => t.status === "IN_PROGRESS");
  const todo = tasks.filter((t) => t.status === "TODO");
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const done = tasks.filter((t) => t.status === "DONE");

  return toolResult({
    project: path.basename(path.resolve(projectPath)),
    current_stage: currentStage.trim().slice(0, 500) || "Not set",
    context_state: contextState.trim().slice(0, 500) || "Not set",
    task_summary: {
      total: tasks.length,
      in_progress: active.length,
      todo: todo.length,
      blocked: blocked.length,
      done: done.length,
    },
    active_tasks: active.map((t) => ({ id: t.id, task: t.task, priority: t.priority })),
    blocked_tasks: blocked.map((t) => ({ id: t.id, task: t.task, details: t.details })),
  });
}

// ── get_today ──────────────────────────────────────────────────────────

export function getToday(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);

  const active = tasks.filter((t) => t.status === "IN_PROGRESS");
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const todo = tasks.filter((t) => t.status === "TODO");

  const checklist: string[] = [];
  for (const t of active) checklist.push(`- [~] ${t.id}: ${t.task} (IN_PROGRESS, ${t.priority})`);
  for (const t of blocked) checklist.push(`- [!] ${t.id}: ${t.task} (BLOCKED, ${t.priority})`);
  for (const t of todo) checklist.push(`- [ ] ${t.id}: ${t.task} (TODO, ${t.priority})`);

  return toolResult({
    date: new Date().toISOString().slice(0, 10),
    project: path.basename(path.resolve(projectPath)),
    in_progress: active.length,
    todo: todo.length,
    blocked: blocked.length,
    checklist: checklist.length > 0 ? checklist.join("\n") : "No active tasks. Use /task to create one.",
  });
}

// ── update_task ────────────────────────────────────────────────────────

export function updateTask(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";
  const newStatus = (args.status as string) || "";
  const evidence = (args.evidence as string) || "";

  if (!taskId) return toolResult({ error: "task_id is required" }, true);
  if (!/^[A-Z]+-\d+(\.\d+)?$/.test(taskId)) {
    return toolResult({ error: `Invalid task_id format: ${taskId}` }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const filepath = path.join(execDir!, TASK_BOARD);
  const content = readFileOrNull(filepath) ?? "";
  if (!content) return toolResult({ error: "Task Board is empty" }, true);

  const lines = content.split("\n");
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) continue;

    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    if (cells[0] !== taskId) continue;

    if (newStatus) cells[2] = newStatus.toUpperCase();
    if (evidence) {
      if (cells.length > 6) {
        const existing = cells[6].trim();
        cells[6] = existing ? `${existing}; ${evidence}` : evidence;
      } else {
        cells.push(evidence);
      }
    }
    lines[i] = "| " + cells.join(" | ") + " |";
    updated = true;
    break;
  }

  if (!updated) return toolResult({ error: `Task ${taskId} not found` }, true);

  atomicWrite(filepath, lines.join("\n"));

  // Sync to individual task file
  const taskFile = path.join(execDir!, TASKS_DIR, `${taskId}.md`);
  const taskContent = readFileOrNull(taskFile);
  if (taskContent !== null) {
    let tc = taskContent;
    if (newStatus) tc = updateFrontmatterField(tc, "status", newStatus.toUpperCase());
    tc = updateFrontmatterField(tc, "updated_at", new Date().toISOString());
    if (evidence) {
      if (tc.includes("## Evidence")) {
        tc = tc.replace(
          "## Evidence\n",
          `## Evidence\n\n- ${new Date().toISOString().slice(0, 10)}: ${evidence}\n`,
        );
      } else {
        tc += `\n## Evidence\n\n- ${new Date().toISOString().slice(0, 10)}: ${evidence}\n`;
      }
    }
    atomicWrite(taskFile, tc);
  }

  const data: Record<string, unknown> = {
    updated: taskId,
    status: newStatus || "(unchanged)",
    evidence: evidence || "(none)",
  };

  // Auto-commit
  const vaultProject = resolveVaultProject(projectPath);
  if (vaultProject) {
    const sha = autoCommitIfDocRepo(vaultProject, `vault: update ${taskId} → ${newStatus || "evidence"}`);
    if (sha) data.auto_commit = sha;
  }

  try {
    const stats = vaultStats(execDir!);
    const statusIcon = newStatus.toUpperCase() === "DONE" ? "✓" : newStatus.toUpperCase() === "IN_PROGRESS" ? "▶" : "○";
    const detailLines = [`${taskId}  →  ${newStatus || "(unchanged)"}  ${statusIcon}`];
    if (evidence) detailLines.push(`Evidence: ${evidence.slice(0, 36)}`);
    return receiptResult(impactReceipt("Task updated", detailLines, stats), data);
  } catch {
    return toolResult(data);
  }
}

// ── create_task ────────────────────────────────────────────────────────

export function createTask(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const title = (args.title as string) || "";
  const description = (args.description as string) || "";
  const priority = (args.priority as string) || "P1";
  const owner = (args.owner as string) || "Agent";
  const scheduledDate = (args.scheduled_date as string) || "";
  const tags = (args.tags as string[]) || [];
  const blockedBy = (args.blocked_by as string[]) || [];
  const parentTask = (args.parent_task as string) || "";
  const verify = (args.verify as Record<string, unknown>[]) || [];

  if (!title) return toolResult({ error: "title is required" }, true);
  if (parentTask && !/^[A-Z]+-\d+$/.test(parentTask)) {
    return toolResult({ error: `Invalid parent_task format: ${parentTask}` }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const filepath = path.join(execDir!, TASK_BOARD);
  let content = readFileOrNull(filepath) ?? "";
  if (!content.trim()) content = TASK_BOARD_HEADER;

  const tasks = parseTaskBoard(content);

  // Sub-task or main task ID
  let newId: string;
  if (parentTask) {
    let maxSub = 0;
    const re = new RegExp(`^${parentTask.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`);
    for (const t of tasks) {
      const m = t.id.match(re);
      if (m) maxSub = Math.max(maxSub, parseInt(m[1], 10));
    }
    newId = `${parentTask}.${maxSub + 1}`;
  } else {
    newId = nextTaskId(tasks);
  }

  const newRow = `| ${newId} | ${title} | TODO | ${priority} | ${owner} | ${description} |  |`;
  content = content.trimEnd() + "\n" + newRow + "\n";
  atomicWrite(filepath, content);

  // Create individual task file
  const now = new Date().toISOString();
  const systemTags = [`vaultops/task`, `vaultops/priority/${priority.toLowerCase()}`, `vaultops/status/todo`];
  const allTags = [...tags, ...systemTags];
  const tagsYaml = `[${allTags.join(", ")}]`;
  const blockedByYaml = blockedBy.length ? `[${blockedBy.join(", ")}]` : "[]";
  const verifyYaml = verify.length ? serializeVerifyYaml(verify) : "[]";

  let taskFileContent = `---
id: ${newId}
title: "${title}"
status: TODO
priority: ${priority}
owner: ${owner}
created_at: ${now}
scheduled_date: ${scheduledDate}
sprint: null
tags: ${tagsYaml}
blocked_by: ${blockedByYaml}
blocks: []
subtasks: []
parent: ${parentTask || "null"}
verify: ${verifyYaml}
---

# ${newId}: ${title}

## Description

${description || "*(No description provided)*"}

## Acceptance Criteria

- [ ] *(To be filled by BA role — run \`/ba ${newId}\` or \`/enrich ${newId}\`)*
`;

  if (verify.length) {
    taskFileContent += "\n## Verify (Task-as-Code)\n\n";
    taskFileContent += "Completion contract — task is DONE only when all checks pass:\n\n";
    for (const check of verify) {
      const ctype = (check.type as string) || "?";
      const descParts = [`\`${ctype}\``];
      for (const [k, v] of Object.entries(check)) {
        if (k !== "type") descParts.push(`${k}=\`${v}\``);
      }
      taskFileContent += `- [ ] ${descParts.join(" ")}\n`;
    }
    taskFileContent += "\n";
  }

  taskFileContent += `## Notes


## Evidence


## Links
`;

  if (parentTask) {
    taskFileContent += `\n- Parent: [[${parentTask}]]\n`;
    const parentFile = path.join(execDir!, TASKS_DIR, `${parentTask}.md`);
    const parentContent = readFileOrNull(parentFile);
    if (parentContent !== null) {
      atomicWrite(parentFile, updateFrontmatterList(parentContent, "subtasks", newId));
    }
  }

  const taskFilePath = path.join(execDir!, TASKS_DIR, `${newId}.md`);
  atomicWrite(taskFilePath, taskFileContent);

  const result: Record<string, unknown> = { created: newId, title, status: "TODO", file: taskFilePath };
  if (parentTask) result.parent = parentTask;

  // Auto-commit
  const vaultProject = resolveVaultProject(projectPath);
  if (vaultProject) {
    const sha = autoCommitIfDocRepo(vaultProject, `vault: create task ${newId} — ${title}`);
    if (sha) result.auto_commit = sha;
  }

  try {
    const stats = vaultStats(execDir!);
    const parentLine = parentTask ? [`subtask of ${parentTask}`] : [];
    return receiptResult(
      impactReceipt("Task created", [`${newId}  ·  ${title}`, `Priority: ${priority}`, ...parentLine], stats),
      result,
    );
  } catch {
    return toolResult(result);
  }
}

// ── log_step ───────────────────────────────────────────────────────────

export function logStep(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const message = (args.message as string) || "";

  if (!message) return toolResult({ error: "message is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const filepath = path.join(execDir!, EXEC_JOURNAL);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const isoStr = now.toISOString();

  const entry = `\n## ${dateStr} — ${message}\n- Logged: ${isoStr}\n`;
  const existing = readFileOrNull(filepath) ?? "";
  atomicWrite(filepath, existing + entry);

  // Auto-commit
  const vaultProject = resolveVaultProject(projectPath);
  if (vaultProject) {
    autoCommitIfDocRepo(vaultProject, `vault: journal — ${message.slice(0, 50)}`);
  }

  return toolResult({ logged: message, timestamp: isoStr });
}

// ── write_plan ─────────────────────────────────────────────────────────

export function writePlan(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const planContent = (args.content as string) || "";

  if (!planContent) return toolResult({ error: "content is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const filepath = path.join(execDir!, WORK_PLANS);
  const dateStr = new Date().toISOString().slice(0, 10);
  const entry = `\n### ${dateStr} — Plan\n\n${planContent}\n`;
  const existing = readFileOrNull(filepath) ?? "";
  atomicWrite(filepath, existing + entry);

  const data: Record<string, unknown> = { written: true, date: dateStr, file: filepath };

  // Auto-commit
  const vaultProject = resolveVaultProject(projectPath);
  if (vaultProject) {
    const sha = autoCommitIfDocRepo(vaultProject, `vault: update work plans — ${dateStr}`);
    if (sha) data.auto_commit = sha;
  }

  try {
    const stats = vaultStats(execDir!);
    const wordCount = planContent.split(/\s+/).length;
    return receiptResult(
      impactReceipt("Work plan saved", [`Date: ${dateStr}  ·  ~${wordCount} words`, "08-Execution/Work Plans.md"], stats),
      data,
    );
  } catch {
    return toolResult(data);
  }
}

// ── get_kanban ─────────────────────────────────────────────────────────

export function getKanban(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);

  const board: Record<string, { id: string; task: string; priority: string }[]> = {
    IN_PROGRESS: [],
    TODO: [],
    BLOCKED: [],
    DONE: [],
  };

  for (const t of tasks) {
    const status = t.status in board ? t.status : "TODO";
    board[status].push({ id: t.id, task: t.task, priority: t.priority });
  }

  return toolResult({
    project: path.basename(path.resolve(projectPath)),
    board,
    counts: Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])),
  });
}

// ── generate_docs_prompt ───────────────────────────────────────────────

export function generateDocsPrompt(args: ToolArgs): ToolResult {
  const projectPath = path.resolve((args.project_path as string) || ".");
  const vaultProject = resolveVaultProject(projectPath);
  if (!vaultProject) {
    return toolResult({ error: "No vault root found. Run 'vaultops add' first." }, true);
  }

  const repoId = path.basename(projectPath);

  // Scan repo file tree (top 3 levels)
  const ignoreDirs = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "vendor", ".vaultops"]);
  const fileTree: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name)) {
            walk(path.join(dir, entry.name), depth + 1);
          }
        } else {
          const rel = path.relative(projectPath, path.join(dir, entry.name));
          fileTree.push(rel);
        }
      }
    } catch { /* skip inaccessible */ }
  }
  walk(projectPath, 0);

  // Discover section status
  const sectionStatus: Record<string, string> = {};
  const sectionPaths: Record<string, string> = {};

  for (const section of DOC_SECTIONS) {
    const sectionPath = path.join(vaultProject, section);
    sectionPaths[section] = sectionPath;

    try {
      const entries = fs.readdirSync(sectionPath);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));
      if (mdFiles.length === 0) {
        sectionStatus[section] = "EMPTY";
      } else {
        let totalBytes = 0;
        for (const f of mdFiles) {
          try { totalBytes += fs.statSync(path.join(sectionPath, f)).size; } catch { /* skip */ }
        }
        sectionStatus[section] = `HAS_CONTENT (${mdFiles.length} files, ${totalBytes} bytes)`;
      }
    } catch {
      sectionStatus[section] = "MISSING";
    }
  }

  const prompt = `Generate documentation for the project "${repoId}".

## Repository file tree (top 3 levels):
\`\`\`
${fileTree.slice(0, 200).join("\n")}
\`\`\`

## Current documentation status:
${Object.entries(sectionStatus).map(([s, st]) => `- ${s}: ${st}`).join("\n")}

## Instructions:
For each section that is MISSING or EMPTY, generate a starter markdown file.
For sections with HAS_CONTENT, check if the primary file meets VaultOps format standards.
If not, standardize the entire section (refactor all files to standard format).
Focus on:
- 00-Overview: System Architecture.md — high-level architecture diagram and tech stack
- 01-Requirements: Product Goals.md — what the product does and key user stories
- 04-Development: Codebase Map.md — key directories, entry points, patterns
- 06-Operations: Runbook.md — how to start, deploy, monitor
- 07-References: Architecture Decisions.md — key ADRs

Keep each file concise (200-400 words). Use what you can infer from the file tree and any README.md content.
`;

  return toolResult({
    vault_project: vaultProject,
    repo_id: repoId,
    section_paths: sectionPaths,
    sections: sectionStatus,
    file_count: fileTree.length,
    prompt,
    instruction: "Use the Write tool with paths from section_paths to save generated docs to the correct vault location.",
  });
}
