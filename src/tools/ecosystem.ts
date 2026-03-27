/**
 * Ecosystem & Visibility tools (Group F): get_replay, get_stale_docs, get_arch_radar, generate_report
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseTaskBoard, normalizeStatus } from "../fs/markdown-table.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath, resolveVaultProject } from "../vault/resolve.js";
import { TASK_BOARD, EXEC_JOURNAL, TASKS_DIR, RECEIPT_SEP } from "../constants.js";
import { getSyncConfig, getLastSyncStatus, hasGitRepo } from "../sync.js";
import { toolResult, receiptResult } from "./helpers.js";
import { getVelocity } from "./metrics.js";

// ── Helper: discover all NN-* section dirs ────────────────────────────

function discoverAllSectionDirs(vaultPath: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of fs.readdirSync(vaultPath, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{2}-/.test(entry.name)) dirs.push(entry.name);
    }
  } catch { /* ignore */ }
  return dirs;
}

// ── Helper: detect stale docs ─────────────────────────────────────────

function detectStaleDocs(execDir: string, projectPath: string, lookbackHours: number): { section: string; reason: string; file: string }[] {
  const stale: { section: string; reason: string; file: string }[] = [];
  const vaultProject = resolveVaultProject(projectPath);
  if (!vaultProject) return stale;

  const tasksDir = path.join(execDir, TASKS_DIR);
  try { if (!fs.statSync(tasksDir).isDirectory()) return stale; } catch { return stale; }

  const cutoff = new Date(Date.now() - lookbackHours * 3600000).toISOString();
  const changedFiles: string[] = [];

  for (const fname of fs.readdirSync(tasksDir)) {
    if (!fname.endsWith(".md")) continue;
    const tc = readFileOrNull(path.join(tasksDir, fname)) ?? "";
    const { frontmatter: fm, body } = parseFrontmatter(tc);
    if (String(fm.updated_at ?? "") >= cutoff) {
      for (const line of body.split("\n")) {
        for (const m of line.matchAll(/[`'"]?([\w/.-]+\.\w{1,5})[`'"]?/g)) {
          const p = m[1];
          if (p.includes("/") && !p.startsWith("http")) changedFiles.push(p);
        }
      }
    }
  }

  if (!changedFiles.length) return stale;

  for (const section of discoverAllSectionDirs(vaultProject)) {
    const sectionDir = path.join(vaultProject, section);
    try { if (!fs.statSync(sectionDir).isDirectory()) continue; } catch { continue; }
    for (const docFile of fs.readdirSync(sectionDir)) {
      if (!docFile.endsWith(".md")) continue;
      const docContent = readFileOrNull(path.join(sectionDir, docFile)) ?? "";
      for (const cf of changedFiles) {
        const basename = path.basename(cf);
        if (docContent.includes(basename) || docContent.includes(cf)) {
          stale.push({ section: `${section}/${docFile}`, reason: `references ${basename} (recently changed)`, file: cf });
          break;
        }
      }
    }
  }
  return stale;
}

// ── get_replay ────────────────────────────────────────────────────────

export function getReplay(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const hours = Number(args.hours ?? 24);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const journalPath = path.join(execDir!, EXEC_JOURNAL);
  const journal = readFileOrNull(journalPath) ?? "";
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const events: { date: string; message: string }[] = [];
  for (const line of journal.split("\n")) {
    if (!line.startsWith("## ")) continue;
    const content = line.slice(3).trim();
    const parts = content.split(" — ", 2);
    if (parts.length !== 2) continue;
    if (parts[0].trim() >= cutoff.slice(0, 10)) {
      events.push({ date: parts[0].trim(), message: parts[1].trim() });
    }
  }

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const tasks = parseTaskBoard(taskBoardMd);
  const tasksDir = path.join(execDir!, TASKS_DIR);

  const recentDone: Record<string, unknown>[] = [];
  const recentCreated: Record<string, unknown>[] = [];

  for (const t of tasks) {
    const tc = readFileOrNull(path.join(tasksDir, `${t.id}.md`));
    if (!tc) continue;
    const { frontmatter: fm } = parseFrontmatter(tc);

    const updated = String(fm.updated_at ?? "");
    const created = String(fm.created_at ?? "");
    if (updated && updated >= cutoff && normalizeStatus(String(fm.status ?? "")) === "DONE") {
      let cycleH: number | null = null;
      if (created) {
        try {
          const h = (new Date(updated).getTime() - new Date(created).getTime()) / 3600000;
          if (!isNaN(h)) cycleH = Math.round(h * 10) / 10;
        } catch { /* skip */ }
      }
      recentDone.push({ ...t, cycle_hours: cycleH });
    }
    if (created && created >= cutoff) recentCreated.push({ ...t });
  }

  const staleDocs = detectStaleDocs(execDir!, projectPath, hours);

  const period = hours <= 24 ? `last ${hours}h` : `last ${Math.floor(hours / 24)}d`;
  const lines = [RECEIPT_SEP, `  ▶  Session Replay  ·  ${period}`, RECEIPT_SEP, ""];

  if (recentDone.length) {
    lines.push(`  COMPLETED (${recentDone.length})`);
    for (const t of recentDone) {
      const cycle = (t.cycle_hours as number | null) ? ` · ${t.cycle_hours}h` : "";
      lines.push(`  ✓  ${t.id}: ${String(t.task ?? "").slice(0, 40)}${cycle}`);
    }
    lines.push("");
  }

  if (recentCreated.length) {
    lines.push(`  CREATED (${recentCreated.length})`);
    for (const t of recentCreated) lines.push(`  +  ${t.id}: ${String(t.task ?? "").slice(0, 40)}`);
    lines.push("");
  }

  if (events.length) {
    lines.push(`  JOURNAL (${events.length} entries)`);
    for (const e of events.slice(-8)) lines.push(`  ·  ${e.date} — ${e.message.slice(0, 45)}`);
    if (events.length > 8) lines.push(`  ·  +${events.length - 8} more`);
    lines.push("");
  }

  if (staleDocs.length) {
    lines.push(`  ⚠  STALE DOCS (${staleDocs.length})`);
    for (const doc of staleDocs.slice(0, 5)) lines.push(`  ·  ${doc.section}: ${doc.reason.slice(0, 40)}`);
    lines.push("");
  }

  if (!recentDone.length && !recentCreated.length && !events.length) {
    lines.push("  No activity in this period.", "");
  }

  lines.push(RECEIPT_SEP);

  return receiptResult(lines.join("\n"), {
    period_hours: hours,
    tasks_completed: recentDone.length,
    tasks_created: recentCreated.length,
    journal_entries: events.length,
    stale_docs: staleDocs.length,
  });
}

// ── get_stale_docs ────────────────────────────────────────────────────

export function getStaleDocs(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const hours = Number(args.hours ?? 72);

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const stale = detectStaleDocs(execDir!, projectPath, hours);
  if (!stale.length) {
    return toolResult({ status: "all_current", message: "No stale docs detected. All documentation appears up-to-date." });
  }

  return toolResult({
    stale_count: stale.length,
    stale_docs: stale,
    recommendation: `Run /vault:docs to update ${stale.length} stale section(s).`,
    details: stale.map((s) => `- ⚠ **${s.section}**: ${s.reason}`).join("\n"),
  });
}

// ── get_arch_radar ────────────────────────────────────────────────────

export function getArchRadar(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);
  try { if (!fs.statSync(tasksDir).isDirectory()) throw new Error(); } catch {
    return toolResult({ status: "no_data", message: "No tasks found. Complete some tasks first." });
  }

  const taskFiles: Record<string, string[]> = {};
  for (const fname of fs.readdirSync(tasksDir)) {
    if (!fname.endsWith(".md")) continue;
    const tc = readFileOrNull(path.join(tasksDir, fname)) ?? "";
    const { frontmatter: fm, body } = parseFrontmatter(tc);
    const tid = String(fm.id ?? fname.replace(".md", ""));

    const files: string[] = [];
    for (const line of body.split("\n")) {
      for (const m of line.matchAll(/[`'"]?([\w/.-]+\.\w{1,5})[`'"]?/g)) {
        const p = m[1];
        if (p.includes("/") && !p.startsWith("http") && p.length > 5) files.push(p);
      }
    }
    if (files.length) taskFiles[tid] = [...new Set(files)];
  }

  if (Object.keys(taskFiles).length < 3) {
    return toolResult({ status: "insufficient_data", message: `Only ${Object.keys(taskFiles).length} tasks with file data. Need 3+ for coupling analysis.` });
  }

  // Co-change analysis
  const coChanges: Record<string, { count: number; files: string[] }> = {};
  for (const files of Object.values(taskFiles)) {
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = [files[i], files[j]].sort().join(" <-> ");
        if (!coChanges[key]) coChanges[key] = { count: 0, files: [files[i], files[j]].sort() };
        coChanges[key].count++;
      }
    }
  }

  const frequentPairs = Object.entries(coChanges)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count);

  // Hotspots
  const fileFreq: Record<string, number> = {};
  for (const files of Object.values(taskFiles)) {
    for (const f of files) fileFreq[f] = (fileFreq[f] ?? 0) + 1;
  }
  const hotspots = Object.entries(fileFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Insights
  const insights: string[] = [];
  const adrSuggestions: string[] = [];

  if (frequentPairs.length) {
    insights.push(`${frequentPairs.length} file pair(s) always change together (coupling smell)`);
    if (frequentPairs.length >= 3) {
      adrSuggestions.push(`Consider extracting shared logic from ${frequentPairs[0][0]} — changed together ${frequentPairs[0][1].count} times`);
    }
  }

  if (hotspots.length && hotspots[0][1] >= 4) {
    insights.push(`Hotspot: ${hotspots[0][0]} changed in ${hotspots[0][1]} tasks — high change frequency`);
  }

  // Module coupling
  const moduleChanges: Record<string, number> = {};
  for (const files of Object.values(taskFiles)) {
    const modules = new Set<string>();
    for (const f of files) {
      const parts = f.split("/");
      modules.add(parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]);
    }
    if (modules.size > 1) {
      for (const mod of modules) moduleChanges[mod] = (moduleChanges[mod] ?? 0) + 1;
    }
  }

  const crossModule = Object.entries(moduleChanges).filter(([, c]) => c >= 2);
  if (crossModule.length >= 3) {
    insights.push(`${crossModule.length} modules frequently co-change — possible tight coupling`);
    adrSuggestions.push("Review module boundaries — frequent cross-module changes suggest architecture drift");
  }

  // Mermaid diagram
  let mermaid = "graph LR\n";
  for (const [, data] of frequentPairs.slice(0, 8)) {
    const [f1, f2] = data.files;
    const b1 = path.basename(f1);
    const b2 = path.basename(f2);
    mermaid += `    ${b1.replace(/\./g, "_")}[${b1}] -- "${data.count}x" --> ${b2.replace(/\./g, "_")}[${b2}]\n`;
  }

  // Build receipt
  const lines = [RECEIPT_SEP, "  📡  Architecture Radar", RECEIPT_SEP, ""];
  if (hotspots.length) {
    lines.push("  HOTSPOTS (most-changed files)");
    for (const [f, count] of hotspots.slice(0, 5)) {
      lines.push(`  ${"█".repeat(Math.min(count, 10))} ${f} (${count}x)`);
    }
    lines.push("");
  }
  if (frequentPairs.length) {
    lines.push("  COUPLING (files that change together)");
    for (const [pairKey, data] of frequentPairs.slice(0, 5)) {
      lines.push(`  ↔  ${pairKey} (${data.count}x)`);
    }
    lines.push("");
  }
  if (insights.length) {
    lines.push("  INSIGHTS");
    for (const i of insights) lines.push(`  ·  ${i}`);
    lines.push("");
  }
  if (adrSuggestions.length) {
    lines.push("  ADR SUGGESTIONS");
    for (const s of adrSuggestions) lines.push(`  →  ${s}`);
    lines.push("");
  }
  lines.push(RECEIPT_SEP);

  return receiptResult(lines.join("\n"), {
    hotspots: hotspots.slice(0, 10),
    coupling_pairs: frequentPairs.length,
    insights,
    adr_suggestions: adrSuggestions,
    mermaid: frequentPairs.length ? mermaid : null,
    tasks_analyzed: Object.keys(taskFiles).length,
  });
}

// ── generate_report ───────────────────────────────────────────────────

export function generateReport(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const sprintNumber = args.sprint_number as number | undefined;
  let outputPath = (args.output_path as string) || "";

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  let tasks = parseTaskBoard(taskBoardMd);
  const tasksDir = path.join(execDir!, TASKS_DIR);

  if (sprintNumber) {
    const sprintTasks: typeof tasks = [];
    for (const t of tasks) {
      const tc = readFileOrNull(path.join(tasksDir, `${t.id}.md`));
      if (!tc) continue;
      const { frontmatter: fm } = parseFrontmatter(tc);
      if (String(fm.sprint ?? "") === String(sprintNumber)) sprintTasks.push(t);
    }
    tasks = sprintTasks;
  }

  const done = tasks.filter((t) => normalizeStatus(t.status) === "DONE");
  const active = tasks.filter((t) => normalizeStatus(t.status) === "IN_PROGRESS");
  const blocked = tasks.filter((t) => normalizeStatus(t.status) === "BLOCKED");
  const todo = tasks.filter((t) => normalizeStatus(t.status) === "TODO");
  const total = tasks.length;
  const donePct = total ? Math.round((done.length / total) * 100) : 0;

  const velResult = getVelocity({ project_path: projectPath });
  let velData: Record<string, unknown> = {};
  try { velData = JSON.parse(velResult.content[0].text); } catch { /* skip */ }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const projectName = path.basename(path.resolve(projectPath));
  const title = sprintNumber ? `Sprint ${sprintNumber}` : "Project Status";

  const statusColors: Record<string, string> = { DONE: "#22c55e", IN_PROGRESS: "#3b82f6", BLOCKED: "#ef4444", TODO: "#6b7280" };
  let taskRows = "";
  for (const t of tasks) {
    const status = normalizeStatus(t.status);
    const color = statusColors[status] ?? "#6b7280";
    taskRows += `<tr>
            <td style="font-family:monospace;font-weight:600">${escapeHtml(t.id)}</td>
            <td>${escapeHtml(t.task.slice(0, 50))}</td>
            <td><span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(t.priority)}</td>
        </tr>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(projectName)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;padding:32px;max-width:900px;margin:0 auto}
h1{font-size:24px;margin-bottom:4px}
.subtitle{color:#64748b;margin-bottom:24px;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;text-align:center}
.card .value{font-size:32px;font-weight:700;margin-bottom:4px}
.card .label{font-size:13px;color:#64748b}
.done .value{color:#22c55e}
.active .value{color:#3b82f6}
.blocked .value{color:#ef4444}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;margin-bottom:32px}
th{background:#f1f5f9;text-align:left;padding:10px 12px;font-size:13px;color:#475569;font-weight:600}
td{padding:10px 12px;border-top:1px solid #f1f5f9;font-size:14px}
.footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:32px}
.donut{display:flex;align-items:center;gap:16px;margin-bottom:24px}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">${escapeHtml(projectName)} · Generated ${now} · VaultOps</p>

<div class="donut">
<svg width="120" height="120" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" stroke-width="3"/>
    <circle cx="18" cy="18" r="15.9" fill="none" stroke="#22c55e" stroke-width="3"
        stroke-dasharray="${donePct} ${100 - donePct}" stroke-dashoffset="25"
        stroke-linecap="round"/>
    <text x="18" y="20" text-anchor="middle" font-size="8" font-weight="bold" fill="#111">${donePct}%</text>
</svg>
<div>
<div style="font-size:20px;font-weight:700">${done.length}/${total} tasks complete</div>
<div style="color:#64748b;font-size:14px">Avg cycle: ${velData.avg_cycle_time_hours ?? "N/A"}h · Velocity: ${velData.velocity_per_day ?? "N/A"}/day</div>
</div>
</div>

<div class="cards">
<div class="card done"><div class="value">${done.length}</div><div class="label">Done</div></div>
<div class="card active"><div class="value">${active.length}</div><div class="label">In Progress</div></div>
<div class="card blocked"><div class="value">${blocked.length}</div><div class="label">Blocked</div></div>
<div class="card"><div class="value">${todo.length}</div><div class="label">To Do</div></div>
</div>

<table>
<thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Priority</th></tr></thead>
<tbody>${taskRows}</tbody>
</table>

<div class="footer">Generated by VaultOps · Zero dependencies · Share as file</div>
</body>
</html>`;

  // Write to file — validate output_path stays within project directory
  if (!outputPath) {
    outputPath = path.join(projectPath, `report-${title.toLowerCase().replace(/ /g, "-")}.html`);
  } else {
    const resolvedOut = path.resolve(outputPath);
    const projectRoot = path.resolve(projectPath);
    if (!resolvedOut.startsWith(projectRoot)) {
      return toolResult({ error: `output_path must be within project directory: ${outputPath}` }, true);
    }
  }
  atomicWrite(outputPath, html);

  return toolResult({ file: outputPath, title, tasks: total, completion: donePct, message: `Report saved to ${outputPath}. Open in browser to view.` });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── get_sync_status ───────────────────────────────────────────────────────

export function getSyncStatusTool(args: ToolArgs): ToolResult {
  const projectPath = String(args.project_path ?? "");

  if (!projectPath) {
    return toolResult({ error: "project_path is required" }, true);
  }

  const vaultProject = resolveVaultProject(projectPath);
  const syncCfg = getSyncConfig(projectPath);

  if (!syncCfg.enabled) {
    return toolResult({
      enabled: false,
      message: "Git sync not configured. Run: vaultops sync setup",
    });
  }

  if (!vaultProject) {
    return toolResult({ error: "Could not resolve vault path" }, true);
  }

  if (!hasGitRepo(vaultProject)) {
    return toolResult({
      enabled: true,
      error: "No git repository found in vault. Run: vaultops sync setup",
    });
  }

  const status = getLastSyncStatus(projectPath, vaultProject);
  return toolResult({
    enabled: status.enabled,
    mode: status.mode,
    schedule: status.schedule,
    remote: status.remote,
    last_sync_at: status.lastSyncAt ?? null,
    last_status: status.lastStatus ?? null,
    pending_changes: status.pendingChanges,
    has_conflicts: status.hasConflicts,
    vault_path: vaultProject,
    conflict_report: status.hasConflicts
      ? `${vaultProject}/08-Execution/Conflict Report.md`
      : null,
    sync_log: `${vaultProject}/08-Execution/Sync Log.md`,
  });
}
