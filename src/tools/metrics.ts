/**
 * Metrics tools (Group E): get_velocity, get_burndown
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath } from "../vault/resolve.js";
import { TASKS_DIR, SPRINTS_DIR } from "../constants.js";
import { toolResult } from "./helpers.js";

export function getVelocity(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const period = (args.period as string) || "week";

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);
  try {
    if (!fs.statSync(tasksDir).isDirectory()) throw new Error();
  } catch {
    return toolResult({ error: "No task files found. Create tasks first." }, true);
  }

  const completedTasks: Record<string, unknown>[] = [];
  const allTasks: Record<string, unknown>[] = [];

  for (const fname of fs.readdirSync(tasksDir)) {
    if (!fname.endsWith(".md")) continue;
    const content = readFileOrNull(path.join(tasksDir, fname)) ?? "";
    const { frontmatter: fm } = parseFrontmatter(content);

    const taskInfo = {
      id: fm.id ?? fname.replace(".md", ""),
      status: fm.status ?? "TODO",
      created_at: fm.created_at ?? "",
      updated_at: fm.updated_at ?? "",
    };
    allTasks.push(taskInfo);
    if (taskInfo.status === "DONE") completedTasks.push(taskInfo);
  }

  const periodDays: Record<string, number> = { day: 1, week: 7, sprint: 14, month: 30 };
  const days = periodDays[period] ?? 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  const recentCompleted = completedTasks.filter((t) => String(t.updated_at ?? "") >= cutoff);

  // Calculate average cycle time
  const cycleTimes: number[] = [];
  for (const t of completedTasks) {
    const created = String(t.created_at ?? "");
    const updated = String(t.updated_at ?? "");
    if (created && updated) {
      try {
        const c = new Date(created).getTime();
        const u = new Date(updated).getTime();
        if (!isNaN(c) && !isNaN(u)) cycleTimes.push((u - c) / 3600000);
      } catch { /* skip */ }
    }
  }
  const avgCycle = cycleTimes.length ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 10) / 10 : 0;

  return toolResult({
    period,
    period_days: days,
    completed_in_period: recentCompleted.length,
    total_completed: completedTasks.length,
    total_tasks: allTasks.length,
    avg_cycle_time_hours: avgCycle,
    velocity_per_day: days ? Math.round((recentCompleted.length / days) * 100) / 100 : 0,
  });
}

export function getBurndown(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const sprintNumber = Number(args.sprint_number ?? 0);

  if (!sprintNumber) return toolResult({ error: "sprint_number is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const sprintFile = path.join(execDir!, SPRINTS_DIR, `Sprint-${sprintNumber}.md`);
  if (!fileExists(sprintFile)) return toolResult({ error: `Sprint ${sprintNumber} not found.` }, true);

  const content = readFileOrNull(sprintFile) ?? "";
  const { frontmatter: fm } = parseFrontmatter(content);
  const startDate = String(fm.start_date ?? "");
  const endDate = String(fm.end_date ?? "");

  if (!startDate || !endDate) return toolResult({ error: "Sprint missing start_date or end_date." }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);
  let totalTasks = 0;
  let doneTasks = 0;

  try {
    if (fs.statSync(tasksDir).isDirectory()) {
      for (const fname of fs.readdirSync(tasksDir)) {
        if (!fname.endsWith(".md")) continue;
        const taskContent = readFileOrNull(path.join(tasksDir, fname)) ?? "";
        const { frontmatter: taskFm } = parseFrontmatter(taskContent);
        if (String(taskFm.sprint ?? "") === String(sprintNumber)) {
          totalTasks++;
          if (taskFm.status === "DONE") doneTasks++;
        }
      }
    }
  } catch { /* skip */ }

  const remaining = totalTasks - doneTasks;
  const mermaid = `\`\`\`mermaid
xychart-beta
    title "Sprint ${sprintNumber} Burndown"
    x-axis [${startDate} --> ${endDate}]
    y-axis "Remaining Tasks" 0 --> ${totalTasks}
    line "Ideal" [${totalTasks}, 0]
    line "Actual" [${totalTasks}, ${remaining}]
\`\`\``;

  return toolResult({
    sprint: sprintNumber,
    start_date: startDate,
    end_date: endDate,
    total_tasks: totalTasks,
    done_tasks: doneTasks,
    remaining,
    progress_pct: totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0,
    mermaid,
  });
}
