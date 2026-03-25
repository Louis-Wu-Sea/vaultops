/**
 * Task Board markdown table parser.
 *
 * Ported from Python's _parse_task_board(), _next_task_id(), _normalize_status()
 * (lines 446-492).
 */

import type { TaskRow, TaskStatus } from "../types.js";

/**
 * Normalize a raw status string to a canonical TaskStatus.
 */
export function normalizeStatus(raw: string): TaskStatus {
  const s = raw.trim().toLowerCase();

  if (s === "done" || s === "completed" || s === "complete") return "DONE";
  if (s === "in_progress" || s === "in progress" || s === "running") return "IN_PROGRESS";
  if (s === "blocked" || s === "failed" || s === "error") return "BLOCKED";

  // Default: TODO
  return "TODO";
}

/**
 * Parse a Task Board markdown table into an array of TaskRow objects.
 *
 * Expected table format:
 * | ID | Task | Status | Priority | Owner | Details | Evidence |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | EXE-001 | Title | TODO | P1 | Agent | Description | |
 */
export function parseTaskBoard(markdown: string): TaskRow[] {
  const rows: TaskRow[] = [];

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    // Split on pipes, removing leading/trailing empty strings
    const cells = trimmed
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());

    if (cells.length < 6) continue;

    // Skip header row
    if (cells[0].toLowerCase() === "id") continue;

    // Skip separator row (| --- | --- | ... |)
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;

    rows.push({
      id: cells[0],
      task: cells[1],
      status: normalizeStatus(cells[2]),
      rawStatus: cells[2],
      priority: cells[3] ?? "",
      owner: cells[4] ?? "",
      details: cells[5] ?? "",
      evidence: cells[6] ?? "",
    });
  }

  return rows;
}

/**
 * Find the highest EXE-### ID and return the next one.
 *
 * Example: if highest is EXE-042, returns "EXE-043".
 * If no tasks exist, returns "EXE-001".
 */
export function nextTaskId(rows: TaskRow[]): string {
  let maxNum = 0;

  for (const row of rows) {
    const match = row.id.match(/^EXE-(\d+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return `EXE-${String(maxNum + 1).padStart(3, "0")}`;
}

/**
 * Serialize a TaskRow back to a markdown table row string.
 */
export function serializeTaskRow(row: TaskRow): string {
  return `| ${row.id} | ${row.task} | ${row.status} | ${row.priority} | ${row.owner} | ${row.details} | ${row.evidence} |`;
}

/**
 * Build a complete Task Board markdown string from rows.
 */
export function serializeTaskBoard(rows: TaskRow[]): string {
  const header = "| ID | Task | Status | Priority | Owner | Details | Evidence |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- |";
  const dataRows = rows.map(serializeTaskRow);

  return [header, separator, ...dataRows].join("\n") + "\n";
}
