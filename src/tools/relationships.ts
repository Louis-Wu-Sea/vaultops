/**
 * Task relationship tools (Group D): link_tasks, get_task_graph
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseTaskBoard } from "../fs/markdown-table.js";
import { parseFrontmatter, updateFrontmatterField, updateFrontmatterList } from "../fs/frontmatter.js";
import { execPath } from "../vault/resolve.js";
import { TASK_BOARD, TASKS_DIR } from "../constants.js";
import { toolResult } from "./helpers.js";

const VALID_RELS = ["blocked-by", "blocks", "subtask-of", "parent-of", "related-to"] as const;

const INVERSE_MAP: Record<string, string> = {
  "blocked-by": "blocks",
  "blocks": "blocked-by",
  "subtask-of": "parent-of",
  "parent-of": "subtask-of",
  "related-to": "related-to",
};

export function linkTasks(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const sourceTask = (args.source_task as string) || "";
  const targetTask = (args.target_task as string) || "";
  const relationship = (args.relationship as string) || "related-to";

  if (!sourceTask || !targetTask) return toolResult({ error: "source_task and target_task are required" }, true);
  if (!VALID_RELS.includes(relationship as typeof VALID_RELS[number])) {
    return toolResult({ error: `relationship must be one of: ${VALID_RELS.join(", ")}` }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);

  // Create task files if they don't exist
  for (const [taskId, fpath] of [
    [sourceTask, path.join(tasksDir, `${sourceTask}.md`)],
    [targetTask, path.join(tasksDir, `${targetTask}.md`)],
  ] as [string, string][]) {
    try {
      if (!fs.statSync(fpath).isFile()) throw new Error();
    } catch {
      const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
      const tasks = parseTaskBoard(taskBoardMd);
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return toolResult({ error: `Task ${taskId} not found` }, true);

      const now = new Date().toISOString();
      const minimal = `---
id: ${taskId}
title: "${task.task}"
status: ${task.status}
priority: ${task.priority}
owner: ${task.owner}
created_at: ${now}
blocked_by: []
blocks: []
subtasks: []
parent: "null"
---

# ${taskId}: ${task.task}

## Description

${task.details}

## Links
`;
      atomicWrite(fpath, minimal);
    }
  }

  let sourceContent = readFileOrNull(path.join(tasksDir, `${sourceTask}.md`)) ?? "";
  let targetContent = readFileOrNull(path.join(tasksDir, `${targetTask}.md`)) ?? "";
  const inverse = INVERSE_MAP[relationship];

  // Update frontmatter lists
  if (relationship === "blocked-by") {
    sourceContent = updateFrontmatterList(sourceContent, "blocked_by", targetTask);
    targetContent = updateFrontmatterList(targetContent, "blocks", sourceTask);
  } else if (relationship === "blocks") {
    sourceContent = updateFrontmatterList(sourceContent, "blocks", targetTask);
    targetContent = updateFrontmatterList(targetContent, "blocked_by", sourceTask);
  } else if (relationship === "subtask-of") {
    sourceContent = updateFrontmatterField(sourceContent, "parent", targetTask);
    targetContent = updateFrontmatterList(targetContent, "subtasks", sourceTask);
  } else if (relationship === "parent-of") {
    sourceContent = updateFrontmatterList(sourceContent, "subtasks", targetTask);
    targetContent = updateFrontmatterField(targetContent, "parent", sourceTask);
  }

  // Add wiki-links to Links section
  const linkTextSource = `- ${relationship}: [[${targetTask}]]\n`;
  const linkTextTarget = `- ${inverse}: [[${sourceTask}]]\n`;

  if (sourceContent.includes("## Links")) {
    sourceContent = sourceContent.replace("## Links\n", `## Links\n${linkTextSource}`);
  } else {
    sourceContent += `\n## Links\n${linkTextSource}`;
  }

  if (targetContent.includes("## Links")) {
    targetContent = targetContent.replace("## Links\n", `## Links\n${linkTextTarget}`);
  } else {
    targetContent += `\n## Links\n${linkTextTarget}`;
  }

  atomicWrite(path.join(tasksDir, `${sourceTask}.md`), sourceContent);
  atomicWrite(path.join(tasksDir, `${targetTask}.md`), targetContent);

  return toolResult({ linked: true, source: sourceTask, target: targetTask, relationship, inverse });
}

export function getTaskGraph(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";
  const depth = Number(args.depth ?? 2);

  if (!taskId) return toolResult({ error: "task_id is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);

  function readTaskLinks(tid: string): Record<string, unknown> {
    const fpath = path.join(tasksDir, `${tid}.md`);
    const content = readFileOrNull(fpath);
    if (content === null) return { id: tid, exists: false };

    const { frontmatter: fm } = parseFrontmatter(content);
    return {
      id: tid,
      exists: true,
      title: fm.title ?? "",
      status: fm.status ?? "TODO",
      blocked_by: Array.isArray(fm.blocked_by) ? fm.blocked_by : [],
      blocks: Array.isArray(fm.blocks) ? fm.blocks : [],
      subtasks: Array.isArray(fm.subtasks) ? fm.subtasks : [],
      parent: fm.parent ?? "null",
    };
  }

  const visited = new Set<string>();
  const graph: Record<string, unknown>[] = [];

  function traverse(tid: string, currentDepth: number): void {
    if (visited.has(tid) || currentDepth > depth) return;
    visited.add(tid);
    const node = readTaskLinks(tid);
    graph.push(node);
    if (!node.exists) return;

    const related = [
      ...((node.blocked_by as string[]) || []),
      ...((node.blocks as string[]) || []),
      ...((node.subtasks as string[]) || []),
    ];
    for (const r of related) traverse(r, currentDepth + 1);

    const parent = node.parent as string;
    if (parent && parent !== "null") traverse(parent, currentDepth + 1);
  }

  traverse(taskId, 0);

  // Generate Mermaid diagram
  const mermaidLines = ["graph TD"];
  for (const node of graph) {
    if (!node.exists) continue;
    const label = `${node.id}: ${String(node.title ?? "").slice(0, 40)}`;
    const status = String(node.status ?? "TODO");
    const styleClass: Record<string, string> = { DONE: ":::done", IN_PROGRESS: ":::active", BLOCKED: ":::blocked" };
    mermaidLines.push(`    ${node.id}["${label}"]${styleClass[status] ?? ""}`);
    for (const blocked of (node.blocked_by as string[]) || []) {
      mermaidLines.push(`    ${blocked} -->|blocks| ${node.id}`);
    }
    for (const sub of (node.subtasks as string[]) || []) {
      mermaidLines.push(`    ${node.id} -->|subtask| ${sub}`);
    }
  }

  return toolResult({ root: taskId, depth, nodes: graph, mermaid: mermaidLines.join("\n") });
}
