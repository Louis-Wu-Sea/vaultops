/**
 * Sprint & scheduling tools (Group D): schedule_task, get_schedule, create_sprint, assign_to_sprint, get_sprint
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseFrontmatter, updateFrontmatterField } from "../fs/frontmatter.js";
import { execPath } from "../vault/resolve.js";
import { TASKS_DIR, SPRINTS_DIR } from "../constants.js";
import { toolResult } from "./helpers.js";

export function scheduleTask(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";
  const scheduledDate = (args.scheduled_date as string) || "";

  if (!taskId || !scheduledDate) return toolResult({ error: "task_id and scheduled_date are required" }, true);

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    return toolResult({ error: "scheduled_date must be YYYY-MM-DD format" }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskFile = path.join(execDir!, TASKS_DIR, `${taskId}.md`);
  if (!fileExists(taskFile)) {
    return toolResult({ error: `Task file not found: ${taskId}. Create it with create_task first.` }, true);
  }

  let content = readFileOrNull(taskFile) ?? "";
  content = updateFrontmatterField(content, "scheduled_date", scheduledDate);
  atomicWrite(taskFile, content);

  return toolResult({ scheduled: true, task_id: taskId, date: scheduledDate });
}

export function getSchedule(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const today = new Date().toISOString().slice(0, 10);
  const startDate = (args.start_date as string) || today;
  const endDate = (args.end_date as string) || startDate;

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);
  try {
    if (!fs.statSync(tasksDir).isDirectory()) throw new Error();
  } catch {
    return toolResult({ date_range: `${startDate} to ${endDate}`, tasks: [], overdue: [] });
  }

  const scheduled: Record<string, Record<string, unknown>[]> = {};
  const overdue: Record<string, unknown>[] = [];

  for (const fname of fs.readdirSync(tasksDir)) {
    if (!fname.endsWith(".md")) continue;
    const content = readFileOrNull(path.join(tasksDir, fname)) ?? "";
    const { frontmatter: fm } = parseFrontmatter(content);

    const sched = String(fm.scheduled_date ?? "");
    if (!sched || sched === '""' || sched === "null") continue;

    const status = String(fm.status ?? "TODO");
    if (status === "DONE") continue;

    const taskInfo = {
      id: fm.id ?? fname.replace(".md", ""),
      title: String(fm.title ?? "").replace(/^"|"$/g, ""),
      status,
      priority: fm.priority ?? "P1",
      scheduled_date: sched,
    };

    if (sched < today && status !== "DONE") overdue.push(taskInfo);
    if (startDate <= sched && sched <= endDate) {
      if (!scheduled[sched]) scheduled[sched] = [];
      scheduled[sched].push(taskInfo);
    }
  }

  return toolResult({
    date_range: `${startDate} to ${endDate}`,
    scheduled,
    overdue,
    total_scheduled: Object.values(scheduled).reduce((s, v) => s + v.length, 0),
    total_overdue: overdue.length,
  });
}

export function createSprint(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const sprintNumber = Number(args.sprint_number ?? 0);
  const startDate = (args.start_date as string) || "";
  const endDate = (args.end_date as string) || "";
  const goals = (args.goals as string[]) || [];

  if (!sprintNumber || !startDate || !endDate) {
    return toolResult({ error: "sprint_number, start_date, and end_date are required" }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const goalsYaml = goals.length ? "[" + goals.map((g) => `"${g}"`).join(", ") + "]" : "[]";
  const goalsMd = goals.length ? goals.map((g) => `- [ ] ${g}`).join("\n") : "- [ ] *(Add sprint goals)*";

  const sprintContent = `---
sprint: ${sprintNumber}
start_date: ${startDate}
end_date: ${endDate}
status: active
goals: ${goalsYaml}
tags: [vaultops/sprint, vaultops/sprint/active]
---

# Sprint ${sprintNumber}: ${startDate} — ${endDate}

## Goals

${goalsMd}

## Tasks

| ID | Task | Status | Priority | Scheduled |
| --- | --- | --- | --- | --- |
`;

  const filepath = path.join(execDir!, SPRINTS_DIR, `Sprint-${sprintNumber}.md`);
  atomicWrite(filepath, sprintContent);

  return toolResult({ created: true, sprint: sprintNumber, start_date: startDate, end_date: endDate, goals, file: filepath });
}

export function assignToSprint(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskIds = (args.task_ids as string[]) || [];
  const sprintNumber = Number(args.sprint_number ?? 0);

  if (!taskIds.length || !sprintNumber) {
    return toolResult({ error: "task_ids and sprint_number are required" }, true);
  }

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const sprintFile = path.join(execDir!, SPRINTS_DIR, `Sprint-${sprintNumber}.md`);
  if (!fileExists(sprintFile)) {
    return toolResult({ error: `Sprint ${sprintNumber} not found. Create it first.` }, true);
  }

  const assigned: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (const taskId of taskIds) {
    const taskFile = path.join(execDir!, TASKS_DIR, `${taskId}.md`);
    if (!fileExists(taskFile)) {
      errors.push(`${taskId}: task file not found`);
      continue;
    }

    let content = readFileOrNull(taskFile) ?? "";
    content = updateFrontmatterField(content, "sprint", String(sprintNumber));
    atomicWrite(taskFile, content);

    const { frontmatter: fm } = parseFrontmatter(content);
    assigned.push({
      id: taskId,
      title: String(fm.title ?? "").replace(/^"|"$/g, ""),
      status: fm.status ?? "TODO",
      priority: fm.priority ?? "P1",
      scheduled_date: fm.scheduled_date ?? "",
    });
  }

  // Update sprint file with task rows
  let sprintContent = readFileOrNull(sprintFile) ?? "";
  for (const task of assigned) {
    const row = `| [[${task.id}]] | ${task.title} | ${task.status} | ${task.priority} | ${task.scheduled_date} |`;
    sprintContent = sprintContent.trimEnd() + "\n" + row + "\n";
  }
  atomicWrite(sprintFile, sprintContent);

  return toolResult({ sprint: sprintNumber, assigned: assigned.map((t) => t.id), errors });
}

export function getSprint(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  let sprintNumber: string | number = (args.sprint_number as string) || "current";

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const sprintsDir = path.join(execDir!, SPRINTS_DIR);

  if (sprintNumber === "current") {
    try {
      if (!fs.statSync(sprintsDir).isDirectory()) throw new Error();
    } catch {
      return toolResult({ error: "No sprints directory found. Create a sprint first." }, true);
    }

    let found = false;
    for (const fname of fs.readdirSync(sprintsDir).sort()) {
      if (!fname.endsWith(".md")) continue;
      const content = readFileOrNull(path.join(sprintsDir, fname)) ?? "";
      const { frontmatter: fm } = parseFrontmatter(content);
      if (fm.status === "active") {
        sprintNumber = Number(fm.sprint ?? 0);
        found = true;
        break;
      }
    }
    if (!found) return toolResult({ error: "No active sprint found." }, true);
  } else {
    sprintNumber = Number(sprintNumber);
  }

  const sprintFile = path.join(sprintsDir, `Sprint-${sprintNumber}.md`);
  if (!fileExists(sprintFile)) return toolResult({ error: `Sprint ${sprintNumber} not found.` }, true);

  const content = readFileOrNull(sprintFile) ?? "";
  const { frontmatter: fm } = parseFrontmatter(content);

  // Read current statuses from task files
  const tasksDir = path.join(execDir!, TASKS_DIR);
  const sprintTasks: Record<string, unknown>[] = [];

  try {
    if (fs.statSync(tasksDir).isDirectory()) {
      for (const fname of fs.readdirSync(tasksDir)) {
        if (!fname.endsWith(".md")) continue;
        const taskContent = readFileOrNull(path.join(tasksDir, fname)) ?? "";
        const { frontmatter: taskFm } = parseFrontmatter(taskContent);
        if (String(taskFm.sprint ?? "") === String(sprintNumber)) {
          sprintTasks.push({
            id: taskFm.id ?? fname.replace(".md", ""),
            title: String(taskFm.title ?? "").replace(/^"|"$/g, ""),
            status: taskFm.status ?? "TODO",
            priority: taskFm.priority ?? "P1",
            scheduled_date: taskFm.scheduled_date ?? "",
          });
        }
      }
    }
  } catch { /* tasks dir doesn't exist */ }

  const counts: Record<string, number> = { DONE: 0, IN_PROGRESS: 0, TODO: 0, BLOCKED: 0 };
  for (const t of sprintTasks) {
    const s = String(t.status ?? "TODO");
    counts[s] = (counts[s] ?? 0) + 1;
  }

  return toolResult({
    sprint: sprintNumber,
    start_date: fm.start_date ?? "",
    end_date: fm.end_date ?? "",
    status: fm.status ?? "unknown",
    goals: fm.goals ?? [],
    tasks: sprintTasks,
    counts,
    total: sprintTasks.length,
    progress_pct: sprintTasks.length ? Math.round((counts.DONE / sprintTasks.length) * 100) : 0,
  });
}
