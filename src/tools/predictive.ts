/**
 * Predictive Brain tool (Group F): get_predictions
 *
 * Note: In the Python version, this tool imports from brain_state.py.
 * In TypeScript, we implement the prediction logic inline since we can't
 * dynamically import hooks at runtime. The brain_state module will be
 * shared via compiled output when hooks are ported in Phase 4.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath } from "../vault/resolve.js";
import { TASKS_DIR, RECEIPT_SEP } from "../constants.js";
import { toolResult, receiptResult } from "./helpers.js";

export function getPredictions(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";
  const taskId = (args.task_id as string) || "";
  let workType = (args.work_type as string) || "unknown";
  const files = (args.files as string[]) || [];

  // If task_id provided, read task to infer work type
  if (taskId) {
    const [execDir] = execPath(projectPath);
    if (execDir) {
      const taskFile = path.join(execDir, TASKS_DIR, `${taskId}.md`);
      const content = readFileOrNull(taskFile);
      if (content) {
        const { frontmatter: fm } = parseFrontmatter(content);
        if (workType === "unknown") {
          const tags = Array.isArray(fm.tags) ? fm.tags : [];
          for (const tag of tags) {
            const t = String(tag).toLowerCase();
            if (t.includes("bug")) { workType = "bugfix"; break; }
            if (t.includes("refact")) { workType = "refactor"; break; }
            if (t.includes("feat")) { workType = "new_feature"; break; }
          }
        }
      }
    }
  }

  // Calculate predictions from historical task data
  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const tasksDir = path.join(execDir!, TASKS_DIR);
  const cycleTimes: number[] = [];
  const sameTypeCycles: number[] = [];

  try {
    if (fs.statSync(tasksDir).isDirectory()) {
      for (const fname of fs.readdirSync(tasksDir)) {
        if (!fname.endsWith(".md")) continue;
        const content = readFileOrNull(path.join(tasksDir, fname)) ?? "";
        const { frontmatter: fm } = parseFrontmatter(content);
        if (fm.status !== "DONE") continue;

        const created = String(fm.created_at ?? "");
        const updated = String(fm.updated_at ?? "");
        if (created && updated) {
          try {
            const hours = (new Date(updated).getTime() - new Date(created).getTime()) / 3600000;
            if (hours > 0 && hours < 10000) {
              cycleTimes.push(hours);
              // Check if same work type
              const tags = Array.isArray(fm.tags) ? fm.tags : [];
              if (workType !== "unknown" && tags.some((t: unknown) => String(t).includes(workType))) {
                sameTypeCycles.push(hours);
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* skip */ }

  // Build cycle time prediction
  const samples = sameTypeCycles.length >= 3 ? sameTypeCycles : cycleTimes;
  const sampleSize = samples.length;
  const workTypeMatch = sameTypeCycles.length >= 3;

  let cycleTime: Record<string, unknown>;
  if (sampleSize >= 2) {
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10;
    const rangeLow = Math.round(sorted[Math.floor(sorted.length * 0.25)] * 10) / 10;
    const rangeHigh = Math.round(sorted[Math.floor(sorted.length * 0.75)] * 10) / 10;
    const confidence = sampleSize >= 10 ? "high" : sampleSize >= 5 ? "medium" : "low";

    cycleTime = {
      predicted_hours: avg, range_low: rangeLow, range_high: rangeHigh,
      confidence, sample_size: sampleSize, work_type_match: workTypeMatch,
    };
  } else {
    cycleTime = { predicted_hours: null, confidence: "very_low", sample_size: sampleSize };
  }

  // Risk assessment
  const riskReasons: string[] = [];
  if (files.length > 5) riskReasons.push("Large number of files affected");
  if (workType === "unknown") riskReasons.push("Work type not identified — harder to estimate");
  if (sampleSize < 3) riskReasons.push("Few historical samples for prediction");
  const riskLevel = riskReasons.length >= 2 ? "high" : riskReasons.length === 1 ? "medium" : "low";
  const recommendation = riskLevel === "high" ? "Consider breaking into smaller tasks" : riskLevel === "medium" ? "Monitor progress closely" : "";

  const risk = { risk_level: riskLevel, reasons: riskReasons, recommendation };

  // Priority suggestion
  const suggestedPriority = workType === "bugfix" ? "P1" : workType === "new_feature" ? "P2" : "P2";
  const priority = { suggested_priority: suggestedPriority, reasoning: `Based on work type: ${workType}` };

  const result = { cycle_time: cycleTime, risk, priority };

  // Build receipt
  const confIcons: Record<string, string> = { high: "███", medium: "██░", low: "█░░", very_low: "░░░" };
  const riskIcons: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
  const lines = [RECEIPT_SEP, "  ⬡  Predictive Brain  ·  Forecast", RECEIPT_SEP, ""];

  if ((cycleTime.predicted_hours as number | null) !== null) {
    const conf = String(cycleTime.confidence ?? "");
    lines.push("  ⏳  CYCLE TIME");
    lines.push(`     Predicted: ${cycleTime.predicted_hours}h  (${cycleTime.range_low ?? "?"}–${cycleTime.range_high ?? "?"}h range)`);
    lines.push(`     Confidence: ${confIcons[conf] ?? "░░░"} ${conf}  (${cycleTime.sample_size} samples)`);
    lines.push(`     Based on: ${workTypeMatch ? "same type" : "all types"}`);
    lines.push("");
  } else {
    lines.push("  ⏳  CYCLE TIME: not enough data yet", "");
  }

  lines.push(`  ${riskIcons[riskLevel] ?? "⚪"}  RISK: ${riskLevel.toUpperCase()}`);
  for (const r of riskReasons) lines.push(`     · ${r}`);
  if (recommendation) lines.push(`     → ${recommendation}`);
  lines.push("");

  lines.push(`  ✦  PRIORITY: ${suggestedPriority}`);
  lines.push(`     ${priority.reasoning}`);
  lines.push("", RECEIPT_SEP);

  return receiptResult(lines.join("\n"), result);
}
