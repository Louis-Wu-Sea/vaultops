/**
 * Visual & Agile tools (Group F): generate_canvas, generate_retro
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseTaskBoard, normalizeStatus } from "../fs/markdown-table.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath, resolveVaultProject } from "../vault/resolve.js";
import { TASK_BOARD, TASKS_DIR, SPRINTS_DIR, ROLE_OUTPUTS_DIR, VALID_ROLES } from "../constants.js";
import { toolResult } from "./helpers.js";
import { getVelocity } from "./metrics.js";

// ── Canvas generation ─────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = { BLOCKED: "1", IN_PROGRESS: "3", DONE: "4", TODO: "5" };
const COLUMN_X: Record<string, number> = { TODO: 0, IN_PROGRESS: 520, BLOCKED: 1040, DONE: 1560 };
const CARD_W = 460, CARD_H = 120, GAP = 20, GROUP_PAD = 40;

export function generateCanvas(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const canvasType = (args.canvas_type as string) || "kanban";

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const vaultProject = resolveVaultProject(projectPath);
  if (!vaultProject) return toolResult({ error: "No vault found" }, true);

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  let tasks = parseTaskBoard(taskBoardMd);
  let nodes: Record<string, unknown>[] = [];
  let edges: Record<string, unknown>[] = [];

  if (canvasType === "kanban" || canvasType === "sprint") {
    const sprintNumber = args.sprint_number;
    if (canvasType === "sprint" && sprintNumber) {
      // Filter tasks to sprint — need to read task files for sprint field
      const filteredIds = new Set<string>();
      const tasksDir = path.join(execDir!, TASKS_DIR);
      try {
        for (const fname of fs.readdirSync(tasksDir)) {
          if (!fname.endsWith(".md")) continue;
          const c = readFileOrNull(path.join(tasksDir, fname)) ?? "";
          const { frontmatter: fm } = parseFrontmatter(c);
          if (String(fm.sprint ?? "") === String(sprintNumber)) filteredIds.add(String(fm.id ?? fname.replace(".md", "")));
        }
      } catch { /* skip */ }
      tasks = tasks.filter((t) => filteredIds.has(t.id));
    }

    const groups: Record<string, typeof tasks> = { TODO: [], IN_PROGRESS: [], BLOCKED: [], DONE: [] };
    for (const t of tasks) {
      const s = normalizeStatus(t.status);
      (groups[s] ??= []).push(t);
    }

    const nodeIdMap: Record<string, string> = {};

    for (const [status, colX] of Object.entries(COLUMN_X)) {
      const colTasks = groups[status] ?? [];
      const groupH = Math.max(CARD_H + GROUP_PAD * 2, colTasks.length * (CARD_H + GAP) + GROUP_PAD * 2);
      nodes.push({
        id: `group-${status}`, type: "text",
        text: `## ${status.replace("_", " ")}\n\n${colTasks.length} tasks`,
        x: colX, y: 0, width: CARD_W + GROUP_PAD * 2, height: groupH, color: "6",
      });

      for (let i = 0; i < colTasks.length; i++) {
        const t = colTasks[i];
        const cardId = `task-${t.id}`;
        nodeIdMap[t.id] = cardId;
        const emoji: Record<string, string> = { P1: "🔴", P2: "🟡", P3: "🟢" };
        nodes.push({
          id: cardId, type: "text",
          text: `### ${emoji[t.priority] ?? "⚪"} ${t.id}\n\n${t.task.slice(0, 60)}`,
          x: colX + GROUP_PAD, y: GROUP_PAD + i * (CARD_H + GAP),
          width: CARD_W, height: CARD_H, color: STATUS_COLORS[status] ?? "5",
        });
      }
    }

    // Dependency edges
    for (const t of tasks) {
      const taskFile = path.join(execDir!, TASKS_DIR, `${t.id}.md`);
      const content = readFileOrNull(taskFile);
      if (!content) continue;
      const { frontmatter: fm } = parseFrontmatter(content);
      const blockedBy = Array.isArray(fm.blocked_by) ? fm.blocked_by : [];
      for (const dep of blockedBy) {
        if (dep in nodeIdMap && t.id in nodeIdMap) {
          edges.push({ id: `edge-${dep}-${t.id}`, fromNode: nodeIdMap[dep as string], toNode: nodeIdMap[t.id], label: "blocks" });
        }
      }
    }

  } else if (canvasType === "dependencies") {
    const nodeIdMap: Record<string, string> = {};
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const status = normalizeStatus(t.status);
      const cardId = `task-${t.id}`;
      nodeIdMap[t.id] = cardId;
      nodes.push({
        id: cardId, type: "text",
        text: `### ${t.id}\n\n${t.task.slice(0, 50)}\n\n**${status}**`,
        x: (i % 4) * 520, y: Math.floor(i / 4) * 200,
        width: CARD_W, height: CARD_H + 40, color: STATUS_COLORS[status] ?? "5",
      });
    }
    // Add all edges from task files
    const tasksDir = path.join(execDir!, TASKS_DIR);
    try {
      for (const fname of fs.readdirSync(tasksDir)) {
        if (!fname.endsWith(".md")) continue;
        const content = readFileOrNull(path.join(tasksDir, fname)) ?? "";
        const { frontmatter: fm } = parseFrontmatter(content);
        const tid = String(fm.id ?? fname.replace(".md", ""));
        for (const dep of Array.isArray(fm.blocked_by) ? fm.blocked_by : []) {
          if (dep in nodeIdMap && tid in nodeIdMap) {
            edges.push({ id: `edge-${dep}-${tid}`, fromNode: nodeIdMap[dep as string], toNode: nodeIdMap[tid], label: "blocked-by" });
          }
        }
        for (const sub of Array.isArray(fm.subtasks) ? fm.subtasks : []) {
          if (sub in nodeIdMap && tid in nodeIdMap) {
            edges.push({ id: `edge-${tid}-${sub}`, fromNode: nodeIdMap[tid], toNode: nodeIdMap[sub as string], label: "subtask" });
          }
        }
      }
    } catch { /* skip */ }

  } else if (canvasType === "architecture") {
    // Read System Architecture doc
    const archPath = path.join(vaultProject, "00-Overview", "System Architecture.md");
    const archContent = readFileOrNull(archPath) ?? "";
    const components: { name: string; detail: string }[] = [];
    let inTable = false;
    for (const line of archContent.split("\n")) {
      if (line.includes("| Layer") || line.includes("| 🧩") || line.includes("| Component")) {
        inTable = true; continue;
      }
      if (inTable && line.trim().startsWith("|")) {
        if (line.includes("---")) continue;
        const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cells.length >= 2) components.push({ name: cells[0], detail: cells[1] ?? "" });
      } else if (inTable && !line.trim().startsWith("|")) {
        inTable = false;
      }
    }

    const layerColors: Record<string, string> = { frontend: "4", backend: "2", database: "1", external: "5" };
    for (let i = 0; i < Math.min(components.length, 12); i++) {
      const comp = components[i];
      let color = "5";
      const lower = comp.name.toLowerCase();
      for (const [layer, c] of Object.entries(layerColors)) {
        if (lower.includes(layer) || comp.detail.toLowerCase().includes(layer)) { color = c; break; }
      }
      nodes.push({
        id: `comp-${i}`, type: "text",
        text: `### ${comp.name}\n\n${comp.detail}`,
        x: (i % 3) * 520, y: Math.floor(i / 3) * 250,
        width: CARD_W, height: 180, color,
      });
    }
  } else {
    return toolResult({ error: `Unknown canvas type: ${canvasType}` }, true);
  }

  const canvas = { nodes, edges };
  const canvasPath = path.join(vaultProject, `${canvasType}-board.canvas`);
  atomicWrite(canvasPath, JSON.stringify(canvas, null, 2));

  return toolResult({ created: true, canvas_type: canvasType, file: canvasPath, nodes_count: nodes.length, edges_count: edges.length });
}

// ── Retrospective generation ──────────────────────────────────────────

function parseVerifyChecks(fm: Record<string, unknown>): Record<string, unknown>[] {
  const raw = fm.verify;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  return [];
}

export function generateRetro(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const sprintNumber = Number(args.sprint_number ?? 0);

  if (!sprintNumber) return toolResult({ error: "sprint_number is required" }, true);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const sprintFile = path.join(execDir!, SPRINTS_DIR, `Sprint-${sprintNumber}.md`);
  if (!fileExists(sprintFile)) return toolResult({ error: `Sprint ${sprintNumber} not found` }, true);

  const sprintContent = readFileOrNull(sprintFile) ?? "";
  const { frontmatter: fm } = parseFrontmatter(sprintContent);
  const startDate = String(fm.start_date ?? "");
  const endDate = String(fm.end_date ?? "");
  const goals = Array.isArray(fm.goals) ? (fm.goals as string[]) : [];

  // Get velocity data
  const velResult = getVelocity({ project_path: projectPath });
  let velData: Record<string, unknown> = {};
  try {
    velData = JSON.parse(velResult.content[0].text);
  } catch { /* skip */ }

  // Collect sprint tasks with detailed analysis
  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);
  const sprintTasksDetailed: Record<string, unknown>[] = [];
  const tasksDir = path.join(execDir!, TASKS_DIR);

  for (const t of tasks) {
    const tf = path.join(tasksDir, `${t.id}.md`);
    const tc = readFileOrNull(tf);
    if (!tc) continue;
    const { frontmatter: tfm } = parseFrontmatter(tc);
    if (String(tfm.sprint ?? "") !== String(sprintNumber)) continue;

    let cycleHours: number | null = null;
    const created = String(tfm.created_at ?? "");
    const updated = String(tfm.updated_at ?? "");
    if (created && updated) {
      try {
        const h = (new Date(updated).getTime() - new Date(created).getTime()) / 3600000;
        if (!isNaN(h)) cycleHours = Math.round(h * 10) / 10;
      } catch { /* skip */ }
    }

    const rolesDone: string[] = [];
    const roleODir = path.join(execDir!, ROLE_OUTPUTS_DIR, t.id);
    try {
      for (const rf of fs.readdirSync(roleODir)) {
        if (rf.endsWith(".md")) rolesDone.push(rf.replace(".md", ""));
      }
    } catch { /* skip */ }

    const verifyChecks = parseVerifyChecks(tfm as Record<string, unknown>);

    sprintTasksDetailed.push({
      ...t, cycle_hours: cycleHours, roles_done: rolesDone,
      has_verify: verifyChecks.length > 0, priority: tfm.priority ?? "P2",
    });
  }

  const doneTasks = sprintTasksDetailed.filter((t) => normalizeStatus(String(t.status ?? "")) === "DONE");
  const blockedTasks = sprintTasksDetailed.filter((t) => normalizeStatus(String(t.status ?? "")) === "BLOCKED");
  const inProgress = sprintTasksDetailed.filter((t) => normalizeStatus(String(t.status ?? "")) === "IN_PROGRESS");
  const doneCount = doneTasks.length;
  const total = sprintTasksDetailed.length;
  const completionPct = total ? Math.round((doneCount / total) * 100) : 0;

  // Insights generation
  const insightsWell: string[] = [];
  const insightsBad: string[] = [];
  const insightsPatterns: string[] = [];

  const cycleTimes = doneTasks.map((t) => t.cycle_hours as number | null).filter((h): h is number => h !== null);
  const avgCycle = cycleTimes.length ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 10) / 10 : 0;

  if (cycleTimes.length) {
    const fastest = Math.min(...cycleTimes);
    const slowest = Math.max(...cycleTimes);
    if (fastest < avgCycle * 0.5) {
      const ft = doneTasks.find((t) => t.cycle_hours === fastest);
      insightsWell.push(`${ft?.id} completed in ${fastest}h (vs avg ${avgCycle}h) — speed record`);
    }
    if (slowest > avgCycle * 2 && cycleTimes.length > 2) {
      const st = doneTasks.find((t) => t.cycle_hours === slowest);
      insightsBad.push(`${st?.id} took ${slowest}h (${Math.round((slowest / avgCycle) * 10) / 10}x avg) — investigate blockers`);
    }
  }

  // Role enrichment impact
  const enriched = doneTasks.filter((t) => ((t.roles_done as string[]) ?? []).length >= 3);
  const unenriched = doneTasks.filter((t) => ((t.roles_done as string[]) ?? []).length === 0);
  if (enriched.length && unenriched.length) {
    const eC = enriched.map((t) => t.cycle_hours as number).filter((h) => h > 0);
    const uC = unenriched.map((t) => t.cycle_hours as number).filter((h) => h > 0);
    if (eC.length && uC.length) {
      const avgE = eC.reduce((a, b) => a + b, 0) / eC.length;
      const avgU = uC.reduce((a, b) => a + b, 0) / uC.length;
      if (avgE < avgU) {
        insightsPatterns.push(`Role-enriched tasks completed ${Math.round((1 - avgE / avgU) * 100)}% faster (${Math.round(avgE * 10) / 10}h vs ${Math.round(avgU * 10) / 10}h)`);
      } else {
        insightsPatterns.push("Role enrichment didn't speed up completion this sprint — review if roles are adding value");
      }
    }
  }

  const verifiedTasks = sprintTasksDetailed.filter((t) => t.has_verify);
  if (verifiedTasks.length) insightsPatterns.push(`${verifiedTasks.length}/${total} tasks had verify contracts — Task-as-Code adoption`);
  if (blockedTasks.length) insightsBad.push(`${blockedTasks.length} task${blockedTasks.length !== 1 ? "s" : ""} still BLOCKED: ${blockedTasks.map((t) => t.id).join(", ")}`);
  if (inProgress.length) insightsBad.push(`${inProgress.length} task${inProgress.length !== 1 ? "s" : ""} carried over (IN_PROGRESS): ${inProgress.map((t) => t.id).join(", ")}`);
  if (completionPct >= 90) insightsWell.push(`${completionPct}% completion rate — strong sprint execution`);
  else if (completionPct < 50 && total > 2) insightsBad.push(`Only ${completionPct}% completion — possible over-commitment or scope creep`);

  // Build markdown
  const now = new Date().toISOString().slice(0, 10);
  const goalsMd = goals.length
    ? goals.map((g, i) => `- ${i < doneCount ? "[x]" : "[ ]"} ${g}`).join("\n")
    : "- *(No goals set)*";

  const throughput = velData.velocity_per_day ?? "N/A";
  const velAvgCycle = velData.avg_cycle_time_hours ?? avgCycle;

  const wellMd = insightsWell.length ? insightsWell.map((i) => `- ${i}`).join("\n") : "- *(No auto-detected positives — fill in during retro)*";
  const badMd = insightsBad.length ? insightsBad.map((i) => `- ${i}`).join("\n") : "- *(No auto-detected issues — fill in during retro)*";
  const patternsMd = insightsPatterns.length ? insightsPatterns.map((i) => `- ${i}`).join("\n") : "- *(Not enough data for patterns yet)*";

  let taskRows = "";
  for (const t of sprintTasksDetailed) {
    const status = normalizeStatus(String(t.status ?? "TODO"));
    const icon: Record<string, string> = { DONE: "✓", IN_PROGRESS: "▶", BLOCKED: "⛔", TODO: "○" };
    const cycleStr = (t.cycle_hours as number | null) !== null ? `${t.cycle_hours}h` : "-";
    const rolesStr = ((t.roles_done as string[]) ?? []).join(", ") || "-";
    const verifyStr = t.has_verify ? "✓" : "-";
    taskRows += `| ${t.id} | ${String(t.task ?? "").slice(0, 30)} | ${icon[status] ?? "○"} ${status} | ${cycleStr} | ${rolesStr} | ${verifyStr} |\n`;
  }

  const retroContent = `---
sprint: ${sprintNumber}
type: retrospective
created: ${now}
tags: [vaultops/sprint, vaultops/retro]
---

# 🔄 Sprint ${sprintNumber} Retrospective

> **Period:** ${startDate} — ${endDate}
> **Completion:** ${completionPct}% (${doneCount}/${total} tasks)

---

## 📊 Metrics

| Metric | Value |
|--------|-------|
| Tasks completed | ${doneCount}/${total} |
| Completion rate | ${completionPct}% |
| Avg cycle time | ${velAvgCycle}h |
| Velocity | ${throughput} tasks/day |
| Tasks with verify contracts | ${verifiedTasks.length}/${total} |
| Tasks with role enrichment | ${sprintTasksDetailed.filter((t) => ((t.roles_done as string[]) ?? []).length > 0).length} |

---

## 📋 Task Breakdown

| ID | Task | Status | Cycle | Roles | Verify |
|----|------|--------|-------|-------|--------|
${taskRows}
---

## 🎯 Goal Review

${goalsMd}

---

## ✅ What Went Well (auto-detected)

${wellMd}

> [!SUCCESS] Keep doing
> - *Add your own observations here*

---

## ❌ What Didn't Go Well (auto-detected)

${badMd}

> [!WARNING] Stop doing
> - *Add your own observations here*

---

## 🔍 Patterns Detected

${patternsMd}

---

## 💡 Action Items for Next Sprint

| # | Action | Owner | Due |
|---|--------|-------|-----|
| 1 | *{{action}}* | *{{owner}}* | *{{date}}* |

---

## 🎉 Shoutouts

> [!TIP] Recognition
> - *{{who did great work and why}}*
`;

  const retroPath = path.join(execDir!, SPRINTS_DIR, `Sprint-${sprintNumber}-Retro.md`);
  atomicWrite(retroPath, retroContent);

  return toolResult({
    created: true, sprint: sprintNumber, file: retroPath,
    completion_pct: completionPct, tasks_done: doneCount, tasks_total: total,
    insights_generated: insightsWell.length + insightsBad.length + insightsPatterns.length,
  });
}
