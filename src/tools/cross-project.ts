/**
 * Cross-project tools (Group E): search_tasks, create_cross_project_link, get_cross_project_deps
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseTaskBoard } from "../fs/markdown-table.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { resolveVaultProjectFromEntry } from "../vault/resolve.js";
import { loadAllProjects } from "../vault/registry.js";
import { EXEC_DIR, TASK_BOARD, TASKS_DIR } from "../constants.js";
import { toolResult } from "./helpers.js";

/** Validate that a resolved path is within expected bounds (home dir or /tmp). */
function isPathTrusted(resolvedPath: string): boolean {
  const home = os.homedir();
  const rel = path.relative(home, resolvedPath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  // Also allow /tmp for temp paths
  const tmpRel = path.relative(os.tmpdir(), resolvedPath);
  return !tmpRel.startsWith("..") && !path.isAbsolute(tmpRel);
}

export function searchTasks(args: ToolArgs): ToolResult {
  const query = String(args.query ?? "").toLowerCase();
  const statusFilter = String(args.status ?? "");
  const tagFilter = (args.tags as string[]) || [];

  if (!query && !statusFilter && !tagFilter.length) {
    return toolResult({ error: "At least one of query, status, or tags is required" }, true);
  }

  const projects = loadAllProjects();
  if (!projects.length) return toolResult({ error: "No projects registered. Run 'vaultops add' first." }, true);

  const results: Record<string, unknown>[] = [];

  for (const proj of projects) {
    const projPath = proj.path ?? "";
    const repoId = proj.repoId ?? "";
    if (!proj.vaultRoot || !repoId) continue;

    const vaultProject = proj.type === "doc-repo" ? projPath : resolveVaultProjectFromEntry(proj);
    // Validate resolved path is within trusted bounds
    if (!isPathTrusted(path.resolve(vaultProject))) continue;
    const tasksDir = path.join(vaultProject, EXEC_DIR, TASKS_DIR);

    try {
      if (!fs.statSync(tasksDir).isDirectory()) throw new Error();
    } catch {
      // Fall back to task board
      const boardPath = path.join(vaultProject, EXEC_DIR, TASK_BOARD);
      const boardMd = readFileOrNull(boardPath) ?? "";
      for (const task of parseTaskBoard(boardMd)) {
        if (query && !task.task.toLowerCase().includes(query) && !task.id.toLowerCase().includes(query)) continue;
        if (statusFilter && task.status !== statusFilter.toUpperCase()) continue;
        results.push({ ...task, project: repoId, project_path: projPath });
      }
      continue;
    }

    for (const fname of fs.readdirSync(tasksDir)) {
      if (!fname.endsWith(".md")) continue;
      const content = readFileOrNull(path.join(tasksDir, fname)) ?? "";
      const { frontmatter: fm, body } = parseFrontmatter(content);

      const title = String(fm.title ?? "").replace(/^"|"$/g, "");
      const taskId = String(fm.id ?? fname.replace(".md", ""));
      const status = String(fm.status ?? "TODO");
      let taskTags = fm.tags ?? [];
      if (typeof taskTags === "string") taskTags = [taskTags];

      if (query && !title.toLowerCase().includes(query) && !taskId.toLowerCase().includes(query) && !body.toLowerCase().includes(query)) continue;
      if (statusFilter && status !== statusFilter.toUpperCase()) continue;
      if (tagFilter.length && !(taskTags as string[]).some((t: string) => tagFilter.includes(t))) continue;

      results.push({
        id: taskId, title, status,
        priority: fm.priority ?? "",
        project: repoId, project_path: projPath,
        tags: taskTags, scheduled_date: fm.scheduled_date ?? "",
      });
    }
  }

  return toolResult({ query, results, total: results.length, projects_searched: projects.length });
}

export function createCrossProjectLink(args: ToolArgs): ToolResult {
  const sourceProject = (args.source_project as string) || "";
  const sourceTask = (args.source_task as string) || "";
  const targetProject = (args.target_project as string) || "";
  const targetTask = (args.target_task as string) || "";
  const relationship = (args.relationship as string) || "related-to";

  if (!sourceProject || !sourceTask || !targetProject || !targetTask) {
    return toolResult({ error: "source_project, source_task, target_project, target_task are all required" }, true);
  }

  const projects = loadAllProjects();
  const sourceProj = projects.find((p) => p.repoId === sourceProject || p.path === sourceProject);
  const targetProj = projects.find((p) => p.repoId === targetProject || p.path === targetProject);

  if (!sourceProj) return toolResult({ error: `Source project not found: ${sourceProject}` }, true);
  if (!targetProj) return toolResult({ error: `Target project not found: ${targetProject}` }, true);

  // Write cross-project link to both task files
  for (const [proj, taskId, linkText] of [
    [sourceProj, sourceTask, `- ${relationship}: [[${targetProject}/${targetTask}]] (cross-project)\n`],
    [targetProj, targetTask, `- ${relationship} (from): [[${sourceProject}/${sourceTask}]] (cross-project)\n`],
  ] as [typeof sourceProj, string, string][]) {
    const vaultProject = resolveVaultProjectFromEntry(proj);
    const taskFile = path.join(vaultProject, EXEC_DIR, TASKS_DIR, `${taskId}.md`);
    const content = readFileOrNull(taskFile);
    if (content !== null) {
      let updated = content;
      if (updated.includes("## Links")) {
        updated = updated.replace("## Links\n", `## Links\n${linkText}`);
      } else {
        updated += `\n## Links\n${linkText}`;
      }
      atomicWrite(taskFile, updated);
    }
  }

  // Write to shared cross-project links index
  const vaultRoot = sourceProj.vaultRoot ?? "";
  const sharedDir = path.join(vaultRoot, "_shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  const linksFile = path.join(sharedDir, "Cross-Project Links.md");
  let existing = readFileOrNull(linksFile) ?? "";
  if (!existing) {
    existing = "# Cross-Project Links\n\n| Source | Target | Relationship | Date |\n| --- | --- | --- | --- |\n";
  }
  const now = new Date().toISOString().slice(0, 10);
  const newRow = `| ${sourceProject}/${sourceTask} | ${targetProject}/${targetTask} | ${relationship} | ${now} |\n`;
  existing = existing.trimEnd() + "\n" + newRow + "\n";
  atomicWrite(linksFile, existing);

  return toolResult({
    linked: true,
    source: `${sourceProject}/${sourceTask}`,
    target: `${targetProject}/${targetTask}`,
    relationship,
  });
}

export function getCrossProjectDeps(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || "";

  const projects = loadAllProjects();
  if (!projects.length) return toolResult({ error: "No projects registered." }, true);

  let vaultRoot: string | null = null;
  if (projectPath) {
    const proj = projects.find((p) => p.path === projectPath || p.repoId === projectPath);
    if (proj) vaultRoot = proj.vaultRoot ?? null;
  }
  if (!vaultRoot && projects.length) vaultRoot = projects[0].vaultRoot ?? null;
  if (!vaultRoot) return toolResult({ error: "Could not determine vault root." }, true);

  const linksFile = path.join(vaultRoot, "_shared", "Cross-Project Links.md");
  const linksContent = readFileOrNull(linksFile) ?? "";

  const links: Record<string, string>[] = [];
  for (const line of linksContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed.includes("---") || trimmed.toLowerCase().startsWith("| source")) continue;
    const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length >= 3) {
      links.push({
        source: cells[0], target: cells[1], relationship: cells[2],
        date: cells.length > 3 ? cells[3] : "",
      });
    }
  }

  // Generate Mermaid diagram
  const mermaidLines = ["graph LR"];
  const projectNodes = new Set<string>();
  for (const link of links) {
    const srcProj = link.source.split("/")[0];
    const tgtProj = link.target.split("/")[0];
    projectNodes.add(srcProj);
    projectNodes.add(tgtProj);
    mermaidLines.push(`    ${link.source.replace(/\//g, "_")}["${link.source}"] -->|${link.relationship}| ${link.target.replace(/\//g, "_")}["${link.target}"]`);
  }

  return toolResult({
    links, total_links: links.length,
    projects_involved: [...projectNodes],
    mermaid: mermaidLines.join("\n"),
  });
}
