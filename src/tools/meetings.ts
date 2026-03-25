/**
 * Meeting Notes tools (Group G): 7 meeting tools
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseFrontmatter, updateFrontmatterField } from "../fs/frontmatter.js";
import { resolveVaultProjectFromEntry } from "../vault/resolve.js";
import { loadAllProjects } from "../vault/registry.js";
import { resolveMeetingsRoot } from "../vault/resolve.js";
import {
  MEETINGS_DIR, MEETING_INDEX, MEETING_NOTES_DIR, MEETING_SERIES_DIR, MEETING_TEMPLATES_DIR,
  EXEC_DIR, TASKS_DIR,
} from "../constants.js";
import { toolResult } from "./helpers.js";
import { createTask } from "./core.js";

// ── Helpers ───────────────────────────────────────────────────────────

function meetingsRoot(): string | null {
  return resolveMeetingsRoot();
}

function ensureMeetingsStructure(meetingsDir: string): void {
  fs.mkdirSync(path.join(meetingsDir, MEETING_NOTES_DIR), { recursive: true });
  fs.mkdirSync(path.join(meetingsDir, MEETING_SERIES_DIR), { recursive: true });
  fs.mkdirSync(path.join(meetingsDir, MEETING_TEMPLATES_DIR), { recursive: true });

  const indexPath = path.join(meetingsDir, MEETING_INDEX);
  if (!fileExists(indexPath)) {
    atomicWrite(indexPath, "# Meeting Index\n\n| ID | Date | Type | Title | Action Items | Status |\n| --- | --- | --- | --- | --- | --- |\n");
  }

  const templatePath = path.join(meetingsDir, MEETING_TEMPLATES_DIR, "default.md");
  if (!fileExists(templatePath)) {
    atomicWrite(templatePath, defaultMeetingTemplate());
  }
}

function defaultMeetingTemplate(): string {
  return `## 1) TL;DR
-

## 2) Current State
### Product
-

### Growth / Sales
-

### Operations / Team
-

## 3) Decisions Made
- [ ] Decision:
  - Owner:
  - Why:
  - Deadline:

## 4) Action Items
| Priority | Task | Owner | Due Date | Status | Dependencies | Notes |
|---|---|---|---|---|---|---|
| P1 |  |  |  | TODO |  |  |

## 5) Risks / Blockers
- Risk:
  - Impact:
  - Mitigation:

## 6) Main Milestones for Next 7 Days
| Day | Milestone | Success Metric | Owner |
|---|---|---|---|
| Day 1 |  |  |  |

## 7) Open Questions
-

## 8) Follow-up for Next Meeting
- Agenda draft:
  -
`;
}

function nextMeetingId(meetingsDir: string): string {
  let maxNum = 0;
  const notesDir = path.join(meetingsDir, MEETING_NOTES_DIR);
  try {
    for (const fname of fs.readdirSync(notesDir)) {
      if (!fname.endsWith(".md")) continue;
      const content = readFileOrNull(path.join(notesDir, fname)) ?? "";
      const m = content.match(/meeting_id:\s*MTG-(\d+)/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch { /* skip */ }

  const indexPath = path.join(meetingsDir, MEETING_INDEX);
  const indexContent = readFileOrNull(indexPath) ?? "";
  for (const m of indexContent.matchAll(/MTG-(\d+)/g)) {
    maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }

  return `MTG-${String(maxNum + 1).padStart(3, "0")}`;
}

function updateMeetingIndex(meetingsDir: string, meetingId: string, date: string, mtype: string, title: string, status = "draft"): void {
  const indexPath = path.join(meetingsDir, MEETING_INDEX);
  let content = readFileOrNull(indexPath) ?? "";
  if (!content.trim()) {
    content = "# Meeting Index\n\n| ID | Date | Type | Title | Action Items | Status |\n| --- | --- | --- | --- | --- | --- |\n";
  }

  if (content.includes(meetingId)) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(meetingId) && lines[i].trim().startsWith("|")) {
        const cells = lines[i].replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cells.length >= 6) {
          cells[5] = status;
          lines[i] = "| " + cells.join(" | ") + " |";
        }
      }
    }
    content = lines.join("\n");
  } else {
    content = content.trimEnd() + `\n| ${meetingId} | ${date} | ${mtype} | ${title} | 0 | ${status} |\n`;
  }

  atomicWrite(indexPath, content);
}

// ── Tools ─────────────────────────────────────────────────────────────

export function createMeeting(args: ToolArgs): ToolResult {
  const title = (args.title as string) || "";
  const date = (args.date as string) || new Date().toISOString().slice(0, 10);
  const meetingType = (args.meeting_type as string) || "product";
  const series = (args.series as string) || "";
  let participants = (args.participants as string[]) || [];
  let projects = (args.projects as string[]) || [];

  if (!title) return toolResult({ error: "title is required" }, true);

  const mDir = meetingsRoot();
  if (!mDir) return toolResult({ error: "Cannot determine vault root for meetings" }, true);

  ensureMeetingsStructure(mDir);

  // Load series defaults
  if (series) {
    const seriesPath = path.join(mDir, MEETING_SERIES_DIR, `${series}.md`);
    if (fileExists(seriesPath)) {
      const { frontmatter: sfm } = parseFrontmatter(readFileOrNull(seriesPath) ?? "");
      if (!participants.length && Array.isArray(sfm.default_participants)) participants = sfm.default_participants as string[];
      if (!projects.length && Array.isArray(sfm.default_projects)) projects = sfm.default_projects as string[];
    }
  }

  const meetingId = nextMeetingId(mDir);
  const now = new Date().toISOString();
  const participantsYaml = participants.length ? "[" + participants.join(", ") + "]" : "[]";
  const projectsYaml = projects.length ? "[" + projects.join(", ") + "]" : "[]";

  // Load template
  let templatePath = path.join(mDir, MEETING_TEMPLATES_DIR, `${meetingType}.md`);
  if (!fileExists(templatePath)) templatePath = path.join(mDir, MEETING_TEMPLATES_DIR, "default.md");
  const template = fileExists(templatePath) ? readFileOrNull(templatePath) ?? defaultMeetingTemplate() : defaultMeetingTemplate();

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const filename = `${date}-${slug}.md`;

  const fileContent = `---
meeting_id: ${meetingId}
title: "${title}"
date: ${date}
meeting_type: ${meetingType}
series: ${series || "null"}
participants: ${participantsYaml}
projects: ${projectsYaml}
status: draft
action_items_dispatched: false
created_at: ${now}
tags: [vaultops/meeting, vaultops/meeting-type/${meetingType}]
---

# ${title}

## Meta
- Date: ${date}
- Participants: ${participants.length ? participants.join(", ") : "TBD"}
- Meeting Type: ${meetingType}
${series ? `- Series: ${series}` : ""}

${template}`;

  const notePath = path.join(mDir, MEETING_NOTES_DIR, filename);
  atomicWrite(notePath, fileContent);
  updateMeetingIndex(mDir, meetingId, date, meetingType, title);

  return toolResult({ created: meetingId, title, file: notePath, date, meeting_type: meetingType });
}

export function getMeeting(args: ToolArgs): ToolResult {
  const meetingId = (args.meeting_id as string) || "";
  const date = (args.date as string) || "";

  const mDir = meetingsRoot();
  if (!mDir) return toolResult({ error: "Cannot determine vault root for meetings" }, true);

  const notesDir = path.join(mDir, MEETING_NOTES_DIR);
  try { if (!fs.statSync(notesDir).isDirectory()) throw new Error(); } catch {
    return toolResult({ error: "No meetings directory found" }, true);
  }

  for (const fname of fs.readdirSync(notesDir).sort().reverse()) {
    if (!fname.endsWith(".md")) continue;
    const fpath = path.join(notesDir, fname);
    const content = readFileOrNull(fpath) ?? "";

    if (meetingId && content.includes(`meeting_id: ${meetingId}`)) {
      const { frontmatter: fm } = parseFrontmatter(content);
      return toolResult({ meeting_id: meetingId, file: fpath, frontmatter: fm, content });
    }
    if (date && fname.startsWith(date)) {
      const { frontmatter: fm } = parseFrontmatter(content);
      return toolResult({ meeting_id: fm.meeting_id ?? "unknown", file: fpath, frontmatter: fm, content });
    }
  }

  return toolResult({ error: `Meeting not found: ${meetingId || date}` }, true);
}

export function dispatchActionItems(args: ToolArgs): ToolResult {
  const meetingId = (args.meeting_id as string) || "";
  const dryRun = Boolean(args.dry_run);

  if (!meetingId) return toolResult({ error: "meeting_id is required" }, true);

  const mDir = meetingsRoot();
  if (!mDir) return toolResult({ error: "Cannot determine vault root for meetings" }, true);

  const notesDir = path.join(mDir, MEETING_NOTES_DIR);
  let meetingFile = "";
  let meetingContent = "";

  try {
    for (const fname of fs.readdirSync(notesDir)) {
      if (!fname.endsWith(".md")) continue;
      const fpath = path.join(notesDir, fname);
      const content = readFileOrNull(fpath) ?? "";
      if (content.includes(`meeting_id: ${meetingId}`)) {
        meetingFile = fpath;
        meetingContent = content;
        break;
      }
    }
  } catch { /* skip */ }

  if (!meetingFile) return toolResult({ error: `Meeting ${meetingId} not found` }, true);

  const { frontmatter: fm } = parseFrontmatter(meetingContent);
  if ((fm.action_items_dispatched === "true" || fm.action_items_dispatched === true) && !dryRun) {
    return toolResult({ warning: `Action items for ${meetingId} already dispatched. Use dry_run to preview.` });
  }

  // Parse action items table
  const actionItems: Record<string, string>[] = [];
  let inActionSection = false;
  let headerFound = false;

  for (const line of meetingContent.split("\n")) {
    const stripped = line.trim();
    if (/action items/i.test(stripped) && stripped.startsWith("#")) { inActionSection = true; continue; }
    if (inActionSection && stripped.startsWith("#") && !/action items/i.test(stripped)) break;
    if (inActionSection && stripped.startsWith("|")) {
      const cells = stripped.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length < 5) continue;
      if (cells[0].toLowerCase() === "priority" || cells[0] === "" || cells.every((c) => /^:?-+:?$/.test(c))) {
        headerFound = true; continue;
      }
      if (!headerFound) continue;

      const title = cells[1] ?? "";
      const status = cells[4] ?? "TODO";
      if (!title.trim() || status.toUpperCase() === "DONE") continue;

      actionItems.push({
        priority: cells[0] || "P1", title, owner: cells[2] ?? "",
        due_date: cells[3] ?? "", status, notes: cells[6] ?? "",
      });
    }
  }

  if (!actionItems.length) return toolResult({ meeting_id: meetingId, dispatched: 0, message: "No actionable items found" });

  const meetingProjects = Array.isArray(fm.projects) ? fm.projects as string[] : typeof fm.projects === "string" ? fm.projects.split(",").map((s: string) => s.trim()) : [];
  const allProjects = loadAllProjects();
  const createdTasks: Record<string, unknown>[] = [];

  for (const item of actionItems) {
    let targetProject = "";
    let targetPath = "";

    // Check notes for project references
    for (const proj of allProjects) {
      if (proj.repoId && item.notes.includes(proj.repoId)) {
        targetProject = proj.repoId; targetPath = proj.path; break;
      }
    }

    // Fall back to first meeting project
    if (!targetPath && meetingProjects.length) {
      const proj = allProjects.find((p) => meetingProjects.includes(p.repoId));
      if (proj) { targetProject = proj.repoId; targetPath = proj.path; }
    }

    // Fall back to first registered project
    if (!targetPath && allProjects.length) {
      targetProject = allProjects[0].repoId; targetPath = allProjects[0].path;
    }

    const dispatchInfo: Record<string, unknown> = {
      title: item.title, priority: item.priority, owner: item.owner,
      due_date: item.due_date, target_project: targetProject || "unassigned", target_path: targetPath || ".",
    };

    if (dryRun) { createdTasks.push(dispatchInfo); continue; }

    if (targetPath) {
      const result = createTask({
        project_path: targetPath, title: item.title, priority: item.priority,
        owner: item.owner || "Agent", scheduled_date: item.due_date,
        tags: [`meeting/${meetingId}`, "action-item"],
      });
      try {
        const resultData = JSON.parse(result.content[0].text);
        dispatchInfo.task_id = resultData.created ?? "?";
      } catch { /* skip */ }
      createdTasks.push(dispatchInfo);
    }
  }

  if (dryRun) {
    return toolResult({ meeting_id: meetingId, dry_run: true, action_items: createdTasks, message: `Would create ${createdTasks.length} tasks. Run without dry_run to dispatch.` });
  }

  meetingContent = updateFrontmatterField(meetingContent, "action_items_dispatched", "true");
  meetingContent = updateFrontmatterField(meetingContent, "status", "processed");
  atomicWrite(meetingFile, meetingContent);
  updateMeetingIndex(mDir, meetingId, String(fm.date ?? ""), String(fm.meeting_type ?? ""), String(fm.title ?? ""), "processed");

  return toolResult({ meeting_id: meetingId, dispatched: createdTasks.length, tasks: createdTasks });
}

export function linkDecisionToAdr(args: ToolArgs): ToolResult {
  const meetingId = (args.meeting_id as string) || "";
  const decision = (args.decision as string) || "";
  const project = (args.project as string) || "";
  let adrId = (args.adr_id as string) || "";

  if (!meetingId || !decision) return toolResult({ error: "meeting_id and decision are required" }, true);

  const allProjects = loadAllProjects();
  const proj = allProjects.find((p) => p.repoId === project);
  if (!proj) return toolResult({ error: `Project '${project}' not found` }, true);

  const vaultProject = resolveVaultProjectFromEntry(proj);
  const decisionsDir = path.join(vaultProject, "07-References");
  fs.mkdirSync(decisionsDir, { recursive: true });

  if (!adrId) {
    let maxAdr = 0;
    try {
      for (const fname of fs.readdirSync(decisionsDir)) {
        const m = fname.match(/^ADR-(\d+)/);
        if (m) maxAdr = Math.max(maxAdr, parseInt(m[1], 10));
      }
    } catch { /* skip */ }
    adrId = `ADR-${String(maxAdr + 1).padStart(3, "0")}`;

    const now = new Date().toISOString();
    const adrContent = `---
adr_id: ${adrId}
title: "${decision}"
status: accepted
date: ${now.slice(0, 10)}
meeting: ${meetingId}
tags: [vaultops/adr, vaultops/meeting/${meetingId}]
---

# ${adrId}: ${decision}

## Context

Decision made during meeting ${meetingId}.

## Decision

${decision}

## Consequences

*(To be documented)*
`;
    atomicWrite(path.join(decisionsDir, `${adrId}.md`), adrContent);
  }

  return toolResult({ linked: true, meeting_id: meetingId, adr_id: adrId, project, decision });
}

export function createFollowup(args: ToolArgs): ToolResult {
  const meetingId = (args.meeting_id as string) || "";
  const description = (args.description as string) || "";
  const dueDate = (args.due_date as string) || "";
  const assignee = (args.assignee as string) || "";
  const project = (args.project as string) || "";

  if (!meetingId || !description) return toolResult({ error: "meeting_id and description are required" }, true);

  let targetPath = ".";
  if (project) {
    const proj = loadAllProjects().find((p) => p.repoId === project);
    if (proj) targetPath = proj.path;
  }

  const result = createTask({
    project_path: targetPath,
    title: `[Follow-up] ${description}`,
    priority: "P1",
    owner: assignee || "Agent",
    scheduled_date: dueDate,
    tags: [`followup/${meetingId}`, "meeting-followup"],
  });

  let taskId = "?";
  try { taskId = JSON.parse(result.content[0].text).created ?? "?"; } catch { /* skip */ }

  return toolResult({ created: taskId, meeting_id: meetingId, description, due_date: dueDate, project: project || "current" });
}

export function getMeetingDashboard(args: ToolArgs): ToolResult {
  const daysBack = Number(args.days_back ?? 14);
  const projectFilter = (args.project as string) || "";

  const mDir = meetingsRoot();
  if (!mDir) return toolResult({ error: "Cannot determine vault root for meetings" }, true);

  const notesDir = path.join(mDir, MEETING_NOTES_DIR);
  try { if (!fs.statSync(notesDir).isDirectory()) throw new Error(); } catch {
    return toolResult({ meetings: [], undispatched: [], message: "No meetings found" });
  }

  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const recentMeetings: Record<string, unknown>[] = [];
  const undispatched: Record<string, unknown>[] = [];

  for (const fname of fs.readdirSync(notesDir).sort().reverse()) {
    if (!fname.endsWith(".md")) continue;
    const content = readFileOrNull(path.join(notesDir, fname)) ?? "";
    const { frontmatter: fm } = parseFrontmatter(content);

    const meetingDate = String(fm.date ?? "");
    if (meetingDate < cutoff) continue;

    if (projectFilter) {
      let meetingProjects = fm.projects;
      if (typeof meetingProjects === "string") meetingProjects = meetingProjects.split(",").map((s: string) => s.trim());
      if (!Array.isArray(meetingProjects) || !meetingProjects.includes(projectFilter)) continue;
    }

    const meetingId = String(fm.meeting_id ?? "");
    const title = String(fm.title ?? fname);
    const status = String(fm.status ?? "draft");

    // Extract TL;DR
    let tldr = "";
    let inTldr = false;
    for (const line of content.split("\n")) {
      if (/tl;dr/i.test(line)) { inTldr = true; continue; }
      if (inTldr) {
        if (line.trim().startsWith("#")) break;
        if (line.trim().startsWith("- ")) tldr += line.trim().slice(2) + "; ";
      }
    }
    tldr = tldr.replace(/;\s*$/, "").slice(0, 100);

    recentMeetings.push({ meeting_id: meetingId, date: meetingDate, title, status, tldr });

    const dispatched = fm.action_items_dispatched;
    if (dispatched === "false" || dispatched === false || dispatched === "") {
      undispatched.push({ meeting_id: meetingId, date: meetingDate, title });
    }
  }

  // Check overdue follow-ups
  const overdueFollowups: Record<string, unknown>[] = [];
  for (const proj of loadAllProjects()) {
    if (!proj.path) continue;
    const vaultProject = proj.type === "doc-repo" ? proj.path : resolveVaultProjectFromEntry(proj);
    const tasksDir = path.join(vaultProject, EXEC_DIR, TASKS_DIR);
    try {
      for (const fname of fs.readdirSync(tasksDir)) {
        if (!fname.endsWith(".md")) continue;
        const tc = readFileOrNull(path.join(tasksDir, fname)) ?? "";
        const { frontmatter: tfm } = parseFrontmatter(tc);
        const tags = Array.isArray(tfm.tags) ? tfm.tags : typeof tfm.tags === "string" ? tfm.tags.split(",").map((t: string) => t.trim()) : [];
        if (!tags.some((t: unknown) => String(t).includes("followup/") || String(t).includes("meeting/"))) continue;
        const sched = String(tfm.scheduled_date ?? "");
        const st = String(tfm.status ?? "TODO");
        if (sched && sched < today && st !== "DONE") {
          overdueFollowups.push({ task_id: tfm.id ?? fname.replace(".md", ""), title: tfm.title, scheduled_date: sched, project: proj.repoId });
        }
      }
    } catch { /* skip */ }
  }

  // Upcoming series
  const seriesDir = path.join(mDir, MEETING_SERIES_DIR);
  const upcomingSeries: Record<string, unknown>[] = [];
  try {
    for (const fname of fs.readdirSync(seriesDir)) {
      if (!fname.endsWith(".md")) continue;
      const { frontmatter: sfm } = parseFrontmatter(readFileOrNull(path.join(seriesDir, fname)) ?? "");
      upcomingSeries.push({ series_id: sfm.series_id ?? fname.replace(".md", ""), name: sfm.name ?? "", cadence: sfm.cadence ?? "" });
    }
  } catch { /* skip */ }

  return toolResult({ recent_meetings: recentMeetings.slice(0, 10), undispatched, overdue_followups: overdueFollowups, upcoming_series: upcomingSeries, period_days: daysBack });
}

export function getMeetingSeries(args: ToolArgs): ToolResult {
  const seriesId = (args.series_id as string) || "";
  const action = (args.action as string) || "list";
  const name = (args.name as string) || "";
  const cadence = (args.cadence as string) || "weekly";
  const defaultParticipants = (args.default_participants as string[]) || [];
  const defaultProjects = (args.default_projects as string[]) || [];

  const mDir = meetingsRoot();
  if (!mDir) return toolResult({ error: "Cannot determine vault root for meetings" }, true);

  ensureMeetingsStructure(mDir);
  const seriesDir = path.join(mDir, MEETING_SERIES_DIR);

  if (action === "create" && name) {
    const sid = seriesId || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const participantsYaml = defaultParticipants.length ? "[" + defaultParticipants.join(", ") + "]" : "[]";
    const projectsYaml = defaultProjects.length ? "[" + defaultProjects.join(", ") + "]" : "[]";

    const content = `---
series_id: ${sid}
name: "${name}"
cadence: ${cadence}
default_participants: ${participantsYaml}
default_projects: ${projectsYaml}
created_at: ${new Date().toISOString()}
tags: [vaultops/meeting-series]
---

# ${name}

Recurring ${cadence} meeting.
`;
    atomicWrite(path.join(seriesDir, `${sid}.md`), content);
    return toolResult({ created: sid, name, cadence });
  }

  if (seriesId) {
    const fpath = path.join(seriesDir, `${seriesId}.md`);
    if (!fileExists(fpath)) return toolResult({ error: `Series '${seriesId}' not found` }, true);
    const { frontmatter: sfm } = parseFrontmatter(readFileOrNull(fpath) ?? "");

    const recent: Record<string, unknown>[] = [];
    const notesDir = path.join(mDir, MEETING_NOTES_DIR);
    try {
      for (const fname of fs.readdirSync(notesDir).sort().reverse()) {
        if (!fname.endsWith(".md")) continue;
        const nc = readFileOrNull(path.join(notesDir, fname)) ?? "";
        if (nc.includes(`series: ${seriesId}`)) {
          const { frontmatter: nfm } = parseFrontmatter(nc);
          recent.push({ meeting_id: nfm.meeting_id ?? "", date: nfm.date ?? "", title: nfm.title ?? "" });
        }
        if (recent.length >= 5) break;
      }
    } catch { /* skip */ }

    return toolResult({ series: sfm, recent_meetings: recent });
  }

  // List all series
  const result: Record<string, unknown>[] = [];
  try {
    for (const fname of fs.readdirSync(seriesDir)) {
      if (!fname.endsWith(".md")) continue;
      const { frontmatter: sfm } = parseFrontmatter(readFileOrNull(path.join(seriesDir, fname)) ?? "");
      result.push({ series_id: sfm.series_id ?? fname.replace(".md", ""), name: sfm.name ?? "", cadence: sfm.cadence ?? "" });
    }
  } catch { /* skip */ }

  return toolResult({ series: result });
}
