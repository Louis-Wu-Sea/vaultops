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
  predictRisk,
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

    // Auto-complete previous task if we're pivoting
    if (state.active_task_id && state.task_auto_created) {
      logStep({
        project_path: projectPath,
        message: `Pivoting from ${state.active_task_id} to new work`,
      });
    }

    // Create new task
    try {
      const createResult = createTask({
        project_path: projectPath,
        title,
        priority,
        owner: "Agent",
        tags: ["auto-created"],
      });

      // Extract task ID from result
      const content = createResult.content as Array<{ text?: string }>;
      let newId = "";
      if (content?.[0]?.text) {
        const text = content[0].text;
        for (const segment of [text, text.includes("\n\n") ? text.split("\n\n").pop()! : ""]) {
          const s = segment.trim();
          if (s.startsWith("{")) {
            try {
              const parsed = JSON.parse(s) as Record<string, string>;
              newId = parsed.created ?? "";
              if (newId) break;
            } catch { continue; }
          }
        }
      }

      if (newId) {
        // Set to IN_PROGRESS immediately
        updateTask({ project_path: projectPath, task_id: newId, status: "IN_PROGRESS" });
        logStep({ project_path: projectPath, message: `Auto-created ${newId}: ${title}` });

        state.active_task_id = newId;
        state.task_auto_created = true;
        state.phase = "working";
        state.intent = intent;
        state.user_prompt_summary = prompt.slice(0, 200);
        state.original_priority = priority;
        state.intent_match_layer = result.match_layer ?? null;

        outputLines.push(`[VaultOps] Auto-created ${newId}: "${title}" [${priority}, IN_PROGRESS]`);
        if (predictionHint) outputLines.push(`[Predictive Brain] ${predictionHint}`);

        // Risk-based verify suggestion
        try {
          const risk = predictRisk(projectPath, []);
          if (risk.risk_level === "medium" || risk.risk_level === "high") {
            outputLines.push(
              `[Predictive Brain] Risk: ${String(risk.risk_level).toUpperCase()}. ` +
              `Consider adding verify: checks to ${newId}.`
            );
          }
        } catch { /* ignore */ }

        outputLines.push("Task tracking active. Evidence will be collected automatically.");
        outputLines.push("");
        outputLines.push(`VAULTOPS_NEW_TASK: ${newId}`);
        outputLines.push("INSTRUCTION: A new task was just created. Before responding to the user,");
        outputLines.push("use AskUserQuestion to offer role enrichment with two options:");
        outputLines.push(`  Question: "${newId} \u0441\u043e\u0437\u0434\u0430\u043d\u0430. \u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c \u0430\u043d\u0430\u043b\u0438\u0437 \u0440\u043e\u043b\u0435\u0439?"`);
        outputLines.push("  Option 1 \u2014 \u0421\u0435\u0439\u0447\u0430\u0441: BA \u2192 (Designer \u2551 SysAnalyst) \u2192 Developer \u2192 QA");
        outputLines.push("    Full plan ready: stories, UX, architecture, code plan, tests");
        outputLines.push("  Option 2 \u2014 \u041f\u043e\u0437\u0436\u0435: continue answering, task is already tracked");
        outputLines.push(`    /vault:enrich ${newId} \u2014 when ready`);
        outputLines.push("If user picks Option 1: immediately run /vault:enrich on this task.");
        outputLines.push("If user picks Option 2: continue normally without enrichment.");
      }
    } catch { /* Silently fail — don't break user flow */ }
  }

  saveState(projectPath, state);

  if (outputLines.length) {
    process.stdout.write(JSON.stringify({ additionalContext: outputLines.join("\n") }) + "\n");
  }
}

main();
