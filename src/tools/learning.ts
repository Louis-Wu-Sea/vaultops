/**
 * Self-learning tools (Group F): learn_from_history, get_insights, adapt_priority, get_learning_status
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FrontmatterValue, ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { execPath } from "../vault/resolve.js";
import { toolResult } from "./helpers.js";

const LEARNINGS_DIR = "Learnings";
const LEARNING_LOG = "Learning Log.md";
const PATTERNS_FILE = "Patterns.md";
const PROJECT_PROFILE = "Project Profile.md";

interface LearningEvent {
  timestamp: string;
  event_type: string;
  [key: string]: unknown;
}

function parseLearningLog(logContent: string): LearningEvent[] {
  const events: LearningEvent[] = [];
  if (!logContent.trim()) return events;

  let current: LearningEvent | null = null;
  for (const line of logContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") && trimmed.includes(" — ")) {
      if (current) events.push(current);
      const parts = trimmed.slice(3).split(" — ", 2);
      current = { timestamp: parts[0].trim(), event_type: parts.length > 1 ? parts[1].trim() : "unknown" };
    } else if (trimmed.startsWith("- ") && current) {
      const kv = trimmed.slice(2).split(": ", 2);
      if (kv.length === 2) {
        const [key, val] = [kv[0].trim(), kv[1].trim()];
        if (val.toLowerCase() === "true") current[key] = true;
        else if (val.toLowerCase() === "false") current[key] = false;
        else if (val.toLowerCase() === "none") current[key] = null;
        else {
          const num = val.includes(".") ? parseFloat(val) : parseInt(val, 10);
          current[key] = isNaN(num) ? val : num;
        }
      }
    }
  }
  if (current) events.push(current);
  return events;
}

export function learnFromHistory(args: ToolArgs): ToolResult {
  const [execDir, err] = execPath((args.project_path as string) || "");
  if (err) return toolResult({ error: err }, true);

  const learningsDir = path.join(execDir!, LEARNINGS_DIR);
  const logPath = path.join(learningsDir, LEARNING_LOG);

  if (!fileExists(logPath)) {
    return toolResult({ status: "no_history", message: "No learning data yet. VaultOps will start collecting data automatically as you work." });
  }

  const events = parseLearningLog(readFileOrNull(logPath) ?? "");
  if (events.length < 3) {
    return toolResult({ status: "insufficient_data", message: `Only ${events.length} events collected. Need at least 3 for meaningful analysis.`, events_collected: events.length });
  }

  // Intent accuracy
  const intentEvents = events.filter((e) => e.event_type === "intent_classified");
  const corrections = events.filter((e) => e.event_type === "user_correction");
  const totalIntents = intentEvents.length;
  const intentAccuracy = Math.round(((totalIntents - corrections.length) / Math.max(totalIntents, 1)) * 100) / 100;

  const layerCounts: Record<string, number> = {};
  for (const e of intentEvents) {
    const layer = String(e.match_layer ?? "none");
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
  }

  const correctionTypes: Record<string, number> = {};
  for (const c of corrections) {
    const ct = String(c.type ?? "unknown");
    correctionTypes[ct] = (correctionTypes[ct] ?? 0) + 1;
  }

  // Cycle times
  const completed = events.filter((e) => ["task_completed", "session_ended"].includes(e.event_type));
  const cycleByType: Record<string, number[]> = {};
  for (const e of completed) {
    const wt = String(e.work_type ?? "unknown");
    const ct = e.cycle_time_hours;
    if (typeof ct === "number" && ct > 0) {
      (cycleByType[wt] ??= []).push(ct);
    }
  }

  const cycleStats: Record<string, Record<string, number>> = {};
  for (const [wt, times] of Object.entries(cycleByType)) {
    const sorted = [...times].sort((a, b) => a - b);
    cycleStats[wt] = {
      avg_hours: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
      median_hours: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
      count: sorted.length,
    };
  }

  // Auto-completion accuracy
  const autoCompleted = completed.filter((e) => e.auto_completed === true);
  const reopened = corrections.filter((c) => c.type === "task_reopened");
  const autoTotal = autoCompleted.length;
  const autoAccuracy = autoTotal ? Math.round(((autoTotal - reopened.length) / Math.max(autoTotal, 1)) * 100) / 100 : null;

  // Priority accuracy
  const priorityCorrections = corrections.filter((c) => c.type === "priority_changed");
  const priorityTotal = intentEvents.filter((e) => e.priority_assigned).length;
  const priorityAccuracy = priorityTotal ? Math.round(((priorityTotal - priorityCorrections.length) / Math.max(priorityTotal, 1)) * 100) / 100 : null;

  // Work distribution
  const workDist: Record<string, number> = {};
  for (const e of intentEvents) {
    const intent = String(e.classified_intent ?? "unknown");
    if (intent !== "question") workDist[intent] = (workDist[intent] ?? 0) + 1;
  }

  const totalData = events.length;
  const confidence = totalData >= 30 ? "high" : totalData >= 10 ? "medium" : "low";

  // Write Patterns.md
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let patternsContent = `---
last_analyzed: ${nowIso}
total_events: ${totalData}
total_tasks_analyzed: ${completed.length}
confidence: ${confidence}
version: 1
---

# Learned Patterns

## Intent Classification
- Accuracy: ${Math.round(intentAccuracy * 100)}% (${totalIntents - corrections.length}/${totalIntents})
- Total classifications: ${totalIntents}
- Total corrections: ${corrections.length}
`;

  if (Object.keys(layerCounts).length) {
    patternsContent += "\n### Match Layer Distribution\n";
    for (const [layer, cnt] of Object.entries(layerCounts).sort((a, b) => b[1] - a[1])) {
      patternsContent += `- ${layer}: ${cnt} (${Math.round((cnt / Math.max(totalIntents, 1)) * 100)}%)\n`;
    }
  }

  if (Object.keys(cycleStats).length) {
    patternsContent += "\n## Cycle Time by Work Type\n\n| Type | Avg Hours | Median | Count |\n|------|-----------|--------|-------|\n";
    for (const [wt, st] of Object.entries(cycleStats).sort((a, b) => b[1].count - a[1].count)) {
      patternsContent += `| ${wt} | ${st.avg_hours} | ${st.median_hours} | ${st.count} |\n`;
    }
  }

  if (autoAccuracy !== null) patternsContent += `\n## Auto-Completion\n- Accuracy: ${Math.round(autoAccuracy * 100)}%\n- Auto-completed: ${autoTotal}\n- Reopened: ${reopened.length}\n`;
  if (priorityAccuracy !== null) patternsContent += `\n## Priority Calibration\n- Accuracy: ${Math.round(priorityAccuracy * 100)}%\n`;

  fs.mkdirSync(learningsDir, { recursive: true });
  atomicWrite(path.join(learningsDir, PATTERNS_FILE), patternsContent);

  // Write Project Profile
  const dominant = Object.keys(workDist).length ? Object.entries(workDist).sort((a, b) => b[1] - a[1])[0][0] : "unknown";
  const promptCounts = completed.map((e) => e.prompt_count).filter((p): p is number => typeof p === "number" && p > 0);
  const avgPrompts = promptCounts.length ? Math.round((promptCounts.reduce((a, b) => a + b, 0) / promptCounts.length) * 10) / 10 : 0;

  const profileContent = `---
project: ${path.basename(String(args.project_path ?? "unknown"))}
dominant_work_type: ${dominant}
avg_session_prompts: ${avgPrompts}
auto_completion_rate: ${autoAccuracy ?? "N/A"}
intent_accuracy: ${intentAccuracy}
priority_accuracy: ${priorityAccuracy ?? "N/A"}
updated: ${nowIso}
---

# Project Profile

Generated by \`learn_from_history\` on ${nowIso}.
Confidence: **${confidence}** (${totalData} events, ${completed.length} task outcomes).
`;
  atomicWrite(path.join(learningsDir, PROJECT_PROFILE), profileContent);

  return toolResult({
    status: "analyzed", confidence, total_events: totalData,
    tasks_analyzed: completed.length, intent_accuracy: intentAccuracy,
    priority_accuracy: priorityAccuracy, auto_completion_accuracy: autoAccuracy,
    cycle_stats: cycleStats, work_distribution: workDist,
    patterns_file: path.join(learningsDir, PATTERNS_FILE),
  });
}

export function getInsights(args: ToolArgs): ToolResult {
  const [execDir, err] = execPath((args.project_path as string) || "");
  if (err) return toolResult({ error: err }, true);

  const patternsPath = path.join(execDir!, LEARNINGS_DIR, PATTERNS_FILE);
  const profilePath = path.join(execDir!, LEARNINGS_DIR, PROJECT_PROFILE);

  if (!fileExists(patternsPath)) {
    return toolResult({ status: "no_patterns", message: "No patterns analyzed yet. Run learn_from_history first." });
  }

  const { frontmatter: patternsFm } = parseFrontmatter(readFileOrNull(patternsPath) ?? "");
  const { frontmatter: profileFm } = fileExists(profilePath) ? parseFrontmatter(readFileOrNull(profilePath) ?? "") : { frontmatter: {} as Record<string, FrontmatterValue> };

  const confidence = String(patternsFm.confidence ?? "low");
  const totalEvents = patternsFm.total_events ?? 0;
  const insights: Record<string, unknown>[] = [];

  const intentAcc = profileFm.intent_accuracy;
  if (intentAcc !== undefined && intentAcc !== null) {
    const pct = Number(intentAcc) <= 1 ? Math.round(Number(intentAcc) * 100) : Math.round(Number(intentAcc));
    insights.push({
      type: "intent_accuracy",
      message: pct < 80 ? `Intent classification accuracy is ${pct}%. Consider running /vault:learn to review correction patterns.` : `Intent classification is working well at ${pct}% accuracy.`,
      confidence, severity: pct < 80 ? "warning" : "info",
    });
  }

  const autoRate = profileFm.auto_completion_rate;
  if (autoRate && autoRate !== "N/A") {
    const rate = Number(autoRate);
    if (!isNaN(rate) && rate < 0.8) {
      insights.push({ type: "auto_completion", message: `Auto-completion accuracy is ${Math.round(rate * 100)}%. Some tasks are being reopened after auto-close.`, confidence, severity: "warning" });
    }
  }

  const dominant = String(profileFm.dominant_work_type ?? "unknown");
  if (dominant !== "unknown") insights.push({ type: "work_distribution", message: `Most common work type: ${dominant}.`, confidence, severity: "info" });

  return toolResult({
    insights: insights.slice(0, 5), confidence, total_events: totalEvents,
    project_profile: { dominant_work_type: dominant, auto_completion_rate: autoRate, intent_accuracy: intentAcc },
  });
}

export function adaptPriority(args: ToolArgs): ToolResult {
  const [execDir, err] = execPath((args.project_path as string) || "");
  if (err) return toolResult({ error: err }, true);

  const title = (args.title as string) || "";

  // Keyword-based priority
  const p1Stems = ["bug", "broken", "urgent", "critical", "crash", "hotfix", "asap", "баг", "срочн", "критичн", "термінов", "сломал", "поломал", "упал"];
  const p3Stems = ["minor", "cleanup", "chore", "мелоч", "незначн", "дрібниц"];
  const titleLower = title.toLowerCase();
  const words = titleLower.match(/[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+/g) ?? [];

  let keywordPriority = "P2";
  for (const word of words) {
    if (p1Stems.some((s) => word.startsWith(s))) { keywordPriority = "P1"; break; }
  }
  if (keywordPriority === "P2") {
    for (const word of words) {
      if (p3Stems.some((s) => word.startsWith(s))) { keywordPriority = "P3"; break; }
    }
  }

  const logPath = path.join(execDir!, LEARNINGS_DIR, LEARNING_LOG);
  if (!fileExists(logPath)) {
    return toolResult({ keyword_priority: keywordPriority, learned_priority: null, reason: "No learning data yet. Using keyword-based priority.", confidence: "none", recommendation: keywordPriority });
  }

  const events = parseLearningLog(readFileOrNull(logPath) ?? "");
  const corrections = events.filter((e) => e.event_type === "user_correction" && e.type === "priority_changed");

  if (!corrections.length) {
    return toolResult({ keyword_priority: keywordPriority, learned_priority: null, reason: "No priority corrections recorded. Keyword-based priority is reliable.", confidence: "low", recommendation: keywordPriority });
  }

  const upCorrections = corrections.filter((c) => String(c.from ?? "") > String(c.to ?? ""));
  const downCorrections = corrections.filter((c) => String(c.from ?? "") < String(c.to ?? ""));

  if (upCorrections.length > downCorrections.length && upCorrections.length >= 2) {
    const learned = keywordPriority === "P2" ? "P1" : keywordPriority;
    return toolResult({
      keyword_priority: keywordPriority, learned_priority: learned,
      reason: `${upCorrections.length} of ${corrections.length} corrections escalated priority. Suggesting higher.`,
      confidence: corrections.length >= 3 ? "medium" : "low", recommendation: learned,
    });
  }

  return toolResult({
    keyword_priority: keywordPriority, learned_priority: null,
    reason: `${corrections.length} corrections found but no clear pattern.`,
    confidence: "low", recommendation: keywordPriority,
  });
}

export function getLearningStatus(args: ToolArgs): ToolResult {
  const [execDir, err] = execPath((args.project_path as string) || "");
  if (err) return toolResult({ error: err }, true);

  const learningsDir = path.join(execDir!, LEARNINGS_DIR);
  try { if (!fs.statSync(learningsDir).isDirectory()) throw new Error(); } catch {
    return toolResult({ status: "not_started", message: "No learning data yet. VaultOps will start collecting data automatically as you work.", data_points: 0, confidence: "none" });
  }

  const logPath = path.join(learningsDir, LEARNING_LOG);
  const events = parseLearningLog(readFileOrNull(logPath) ?? "");
  const totalEvents = events.length;

  const { frontmatter: patternsFm } = fileExists(path.join(learningsDir, PATTERNS_FILE))
    ? parseFrontmatter(readFileOrNull(path.join(learningsDir, PATTERNS_FILE)) ?? "") : { frontmatter: {} as Record<string, FrontmatterValue> };

  const lastAnalysis = String(patternsFm.last_analyzed ?? "never");
  const confidence = String(patternsFm.confidence ?? "none");

  let eventsSince = 0;
  if (lastAnalysis !== "never") {
    for (const e of events) {
      if (String(e.timestamp ?? "") > lastAnalysis) eventsSince++;
    }
  }

  const { frontmatter: profileFm } = fileExists(path.join(learningsDir, PROJECT_PROFILE))
    ? parseFrontmatter(readFileOrNull(path.join(learningsDir, PROJECT_PROFILE)) ?? "") : { frontmatter: {} as Record<string, FrontmatterValue> };

  const suggestions: string[] = [];
  if (lastAnalysis === "never") suggestions.push("Run learn_from_history to generate your first analysis.");
  else if (eventsSince > 5) suggestions.push(`Run learn_from_history to refresh (${eventsSince} new events since last analysis).`);
  if (totalEvents < 10) suggestions.push(`Keep working — ${10 - totalEvents} more events needed for medium confidence.`);

  return toolResult({
    status: totalEvents > 0 ? "active" : "collecting",
    data_points: totalEvents, last_analysis: lastAnalysis,
    events_since_analysis: eventsSince, confidence,
    tasks_analyzed: patternsFm.total_tasks_analyzed,
    intent_accuracy: profileFm.intent_accuracy,
    priority_accuracy: profileFm.priority_accuracy,
    auto_completion_rate: profileFm.auto_completion_rate,
    dominant_work_type: profileFm.dominant_work_type,
    suggestions,
  });
}
