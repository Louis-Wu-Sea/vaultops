/**
 * VaultOps Brain — UserPromptSubmit hook.
 *
 * Fires on every user prompt. Classifies intent and auto-creates tasks.
 * This is the core autonomy hook — it decides when to create tasks,
 * when to continue existing ones, and when to stay silent.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  isVaultopsProject,
  loadState,
  saveState,
  classifyIntent,
  logLearningEvent,
  predictCycleTime,
  predictPriority,
  type TaskInfo,
} from "./shared/brain-state.js";
import { createTask, updateTask, logStep } from "../tools/core.js";
import { execPath } from "../vault/resolve.js";
import { readFileOrNull } from "../fs/read.js";
import { parseTaskBoard } from "../fs/markdown-table.js";
import { TASK_BOARD } from "../constants.js";

import * as path from "node:path";

function main(): void {
  const projectPath = process.cwd();

  if (!isVaultopsProject(projectPath)) return;

  // Read hook input
  let hookInput: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(0, "utf-8");
    hookInput = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = String(hookInput.prompt ?? "");
  if (!prompt.trim()) return;

  const state = loadState(projectPath);
  state.prompt_count += 1;

  // Already suppressed
  if (state.suppressed) {
    saveState(projectPath, state);
    return;
  }

  // Load existing tasks for classification
  const [execDir, err] = execPath(projectPath);
  if (err) {
    saveState(projectPath, state);
    return;
  }

  const taskBoardMd = readFileOrNull(path.join(execDir!, TASK_BOARD)) ?? "";
  const existingTasks = parseTaskBoard(taskBoardMd) as unknown as TaskInfo[];

  // Detect user corrections from previous session state
  if (state.active_task_id && state.original_priority) {
    for (const t of existingTasks) {
      if (t.id === state.active_task_id) {
        const curPriority = (t as Record<string, unknown>).priority as string ?? "";
        if (curPriority && curPriority !== state.original_priority) {
          logLearningEvent(projectPath, "user_correction", {
            type: "priority_changed",
            task_id: t.id,
            from: state.original_priority,
            to: curPriority,
            signal: "priority_miscalibrated",
          });
          state.original_priority = curPriority;
        }
        const curStatus = (t as Record<string, unknown>).status as string ?? "";
        if (curStatus === "IN_PROGRESS" && state.phase === "idle") {
          logLearningEvent(projectPath, "user_correction", {
            type: "task_reopened",
            task_id: t.id,
            signal: "premature_auto_completion",
          });
        }
        break;
      }
    }
  }

  // Classify intent
  const result = classifyIntent(prompt, existingTasks, state.active_task_id);
  const action = result.action;

  // Log classification event for learning
  const promptHash = crypto.createHash("md5").update(prompt).digest("hex").slice(0, 8);
  logLearningEvent(projectPath, "intent_classified", {
    prompt_hash: promptHash,
    classified_action: action,
    classified_intent: result.intent,
    match_layer: result.match_layer,
    priority_assigned: result.priority,
    active_task: state.active_task_id,
  });

  const outputLines: string[] = [];

  if (action === "suppress") {
    state.suppressed = true;
    saveState(projectPath, state);
    process.stdout.write(JSON.stringify({ additionalContext: "[VaultOps] Tracking suppressed for this session." }) + "\n");
    return;
  }

  if (action === "question") {
    state.intent = "question";
    saveState(projectPath, state);
    return;
  }

  if (action === "reuse") {
    const taskId = result.task_id ?? "";
    if (taskId) {
      state.active_task_id = taskId;
      state.phase = "working";
      state.intent = result.intent ?? "new_feature";
      if (!state.user_prompt_summary) state.user_prompt_summary = prompt.slice(0, 200);
      saveState(projectPath, state);
      outputLines.push(`[VaultOps] Continuing ${taskId}. Changes auto-logged.`);
    } else {
      saveState(projectPath, state);
      return;
    }
  } else if (action === "continue") {
    state.phase = "working";
    saveState(projectPath, state);
    outputLines.push(`[VaultOps] Continuing ${result.task_id ?? ""}. Changes auto-logged.`);
  } else if (action === "create") {
    const title = result.title ?? "Untitled task";
    let priority = result.priority ?? "P2";
    const intent = result.intent ?? "new_feature";

    // Predictive Brain: calibrate priority
    let predictionHint = "";
    try {
      const priorityPred = predictPriority(projectPath, intent);
      if (priorityPred.confidence === "high" || priorityPred.confidence === "medium") {
        const suggested = String(priorityPred.suggested_priority ?? priority);
        if (suggested !== priority) {
          priority = suggested;
          predictionHint += `Priority calibrated to ${priority} (${priorityPred.reasoning ?? ""}). `;
        }
      }

      const cyclePred = predictCycleTime(projectPath, intent);
      if (cyclePred.predicted_hours != null) {
        const hrs = cyclePred.predicted_hours;
        const low = cyclePred.range_low ?? hrs;
        const high = cyclePred.range_high ?? hrs;
        predictionHint += `Estimated: ${low}-${high}h (median ${hrs}h from ${cyclePred.sample_size ?? 0} tasks).`;
      }
    } catch { /* ignore */ }

    // ── Suggest task to Claude — do NOT auto-create ──────────────────
    // Claude will propose the task to the user and create it only on confirmation.
    outputLines.push("VAULTOPS_TASK_SUGGESTION detected.");
    outputLines.push(`  Proposed title: "${title}"`);
    outputLines.push(`  Priority: ${priority}  Intent: ${intent}`);
    if (predictionHint) outputLines.push(`  ${predictionHint}`);
    outputLines.push(`  Project: ${projectPath}`);
    outputLines.push("");
    outputLines.push("INSTRUCTION: Before answering the user's request, ask them:");
    outputLines.push(`  "Создать задачу: '${title}'? [${priority}]"`);
    outputLines.push("If the user confirms (yes/да/создай/ок):");
    outputLines.push(`  Call create_task MCP tool with project_path='${projectPath}',`);
    outputLines.push(`  title='${title}', priority='${priority}'`);
    outputLines.push("  Then set it IN_PROGRESS via update_task.");
    outputLines.push("If the user declines (no/нет/не надо/пропусти):");
    outputLines.push("  Continue normally without creating any task.");
    outputLines.push("Do NOT create the task without explicit confirmation.");
  }

  saveState(projectPath, state);

  if (outputLines.length) {
    process.stdout.write(JSON.stringify({ additionalContext: outputLines.join("\n") }) + "\n");
  }
}

main();
