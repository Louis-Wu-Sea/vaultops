/**
 * VaultOps Brain — Stop hook (session end).
 *
 * Auto-completes tasks when evidence supports it (tests passed + commit),
 * generates a rich impact receipt with task lifecycle, and flags
 * architecture docs that need updating.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  isVaultopsProject,
  loadState,
  cleanupState,
  logLearningEvent,
} from "./shared/brain-state.js";
import { execPath, resolveVaultProject } from "../vault/resolve.js";
import { readFileOrNull, fileExists } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { parseFrontmatter } from "../fs/frontmatter.js";
import { vaultStats, progressBar } from "../tools/helpers.js";
import { updateTask, logStep } from "../tools/core.js";
import { getStaleDocs } from "../tools/ecosystem.js";
import { EXEC_JOURNAL, TASKS_DIR, SPRINTS_DIR } from "../constants.js";
import { getSyncConfig, syncVault, getGitUserIdentity, hasGitRepo } from "../sync.js";

const BRAIN_SEP = "\u2501".repeat(43);

function todayEntries(journalPath: string, today: string): string[] {
  const content = readFileOrNull(journalPath) ?? "";
  const entries: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith(`## ${today}`)) continue;
    const entry = line.replace(new RegExp(`^## ${today.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[\\u2014\\-]\\s*`), "").trim();
    if (entry && !entry.includes("Session ended")) entries.push(entry);
  }
  return entries;
}

interface VerifyResult {
  passed: number;
  total: number;
  all_passed: boolean;
  results: Array<{ type: string; passed: boolean; detail: string }>;
}

function main(): void {
  const projectPath = process.cwd();

  if (!isVaultopsProject(projectPath)) return;

  const [execDir, err] = execPath(projectPath);
  if (err || !execDir) return;

  const state = loadState(projectPath);
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  // Auto-completion logic
  let taskLifecycle: Record<string, unknown> | null = null;
  let autoCompleted = false;
  let verifyResult: VerifyResult | null = null;

  if (state.active_task_id && !state.suppressed) {
    const taskId = state.active_task_id;
    const testsPassed = state.tests_passed;
    const commits = state.commits;
    const testsRun = state.tests_run;
    const filesEdited = state.files_edited;
    const filesCreated = state.files_created;

    // Build evidence summary
    const evidenceParts: string[] = [];
    const fileCount = filesEdited.length + filesCreated.length;
    if (fileCount) evidenceParts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}`);
    if (testsRun) {
      evidenceParts.push(testsPassed ? "tests \u2713" : testsPassed === false ? "tests \u2717" : "tests ran");
    }
    if (commits.length) {
      const shaList = commits.slice(0, 3).map(c => c.sha.slice(0, 7)).join(", ");
      evidenceParts.push(`commit${commits.length > 1 ? "s" : ""} ${shaList}`);
    }
    const evidenceStr = evidenceParts.length ? evidenceParts.join(", ") : "no evidence";

    // Auto-complete: both tests passed AND commit required
    let canComplete = false;
    if (testsPassed && commits.length) canComplete = true;
    else if (!testsRun && commits.length) canComplete = true;

    // Task-as-Code: verify checks gate
    if (canComplete) {
      try {
        const taskFile = path.join(execDir, TASKS_DIR, `${taskId}.md`);
        if (fileExists(taskFile)) {
          const taskContent = readFileOrNull(taskFile) ?? "";
          const { frontmatter: fm } = parseFrontmatter(taskContent);
          if (fm.verify) {
            // Use run_verify tool
            try {
              const { runVerify } = require("../tools/verify.js");
              const vResult = runVerify({ project_path: projectPath, task_id: taskId });
              const content = vResult.content as Array<{ text?: string }>;
              if (content?.[0]?.text) {
                const parsed = JSON.parse(content[0].text);
                if (parsed.has_verify) {
                  verifyResult = {
                    passed: parsed.passed_checks ?? 0,
                    total: parsed.total_checks ?? 0,
                    all_passed: parsed.passed ?? false,
                    results: (parsed.results ?? []) as VerifyResult["results"],
                  };
                  if (!verifyResult.all_passed) canComplete = false;
                }
              }
            } catch { /* ignore verify errors */ }
          }
        }
      } catch { /* ignore */ }
    }

    if (canComplete) {
      try {
        let verifyNote = "";
        if (verifyResult) verifyNote = `, verify ${verifyResult.passed}/${verifyResult.total} \u2713`;
        updateTask({
          project_path: projectPath,
          task_id: taskId,
          status: "DONE",
          evidence: evidenceStr + verifyNote,
        });
        autoCompleted = true;
      } catch { /* ignore */ }
    }

    // Build lifecycle line
    const createdLabel = state.task_auto_created ? "Auto-created" : "Resumed";
    let statusFlow: string;
    if (autoCompleted) {
      statusFlow = `${createdLabel} \u2192 IN_PROGRESS \u2192 DONE`;
    } else if (verifyResult && !verifyResult.all_passed) {
      const failed = verifyResult.total - verifyResult.passed;
      statusFlow = `${createdLabel} \u2192 IN_PROGRESS (verify: ${failed} check${failed !== 1 ? "s" : ""} failed)`;
    } else if (testsPassed === false) {
      statusFlow = `${createdLabel} \u2192 IN_PROGRESS (tests failing)`;
    } else {
      statusFlow = `${createdLabel} \u2192 IN_PROGRESS`;
    }

    taskLifecycle = {
      id: taskId,
      summary: (state.user_prompt_summary ?? "").slice(0, 40),
      status_flow: statusFlow,
      evidence: evidenceStr,
      verify_result: verifyResult,
    };
  }

  // Log task outcome for learning
  if (state.active_task_id && !state.suppressed) {
    let cycleHours = 0;
    if (state.session_start) {
      try {
        const start = new Date(state.session_start);
        cycleHours = Math.round(((Date.now() - start.getTime()) / 3600000) * 100) / 100;
      } catch { /* ignore */ }
    }

    const learningData: Record<string, unknown> = {
      task_id: state.active_task_id,
      auto_completed: autoCompleted,
      auto_created: state.task_auto_created,
      cycle_time_hours: cycleHours,
      work_type: state.intent ?? "unknown",
      files_edited: state.files_edited.length,
      files_created: state.files_created.length,
      tests_run: state.tests_run,
      tests_passed: state.tests_passed,
      commits: state.commits.length,
      prompt_count: state.prompt_count,
      match_layer: state.intent_match_layer,
      original_priority: state.original_priority,
    };

    if (verifyResult !== null) {
      learningData.verify_passed = verifyResult.passed;
      learningData.verify_total = verifyResult.total;
      learningData.verify_all_passed = verifyResult.all_passed;
      if (!verifyResult.all_passed) {
        learningData.verify_failed_types = verifyResult.results
          .filter(r => !r.passed).map(r => r.type).join(", ");
      }
    }

    logLearningEvent(
      projectPath,
      autoCompleted ? "task_completed" : "session_ended",
      learningData,
    );

    if (verifyResult !== null) {
      logLearningEvent(projectPath, "verification_result", {
        task_id: state.active_task_id,
        passed: verifyResult.passed,
        total: verifyResult.total,
        all_passed: verifyResult.all_passed,
        blocked_completion: !verifyResult.all_passed && state.commits.length > 0,
      });
    }
  }

  // Collect vault stats
  let stats: ReturnType<typeof vaultStats>;
  try {
    stats = vaultStats(execDir);
  } catch {
    stats = { done: 0, active: 0, todo: 0, blocked: 0, total: 0, docs: 0 };
  }

  const journalPath = path.join(execDir, EXEC_JOURNAL);
  const entries = todayEntries(journalPath, today);

  const d = stats.done;
  const a = stats.active;
  const t = stats.todo;
  const total = stats.total;
  const docs = stats.docs;
  const bar = progressBar(d, total);

  // Build compact receipt (max ~12 lines)
  const lines: string[] = [BRAIN_SEP];

  // Task outcome line
  if (taskLifecycle) {
    const tid = taskLifecycle.id as string;
    const summary = taskLifecycle.summary as string;
    const label = summary ? `${tid}: ${summary}` : tid;
    lines.push(`  ${label}`);
    lines.push(`  ${taskLifecycle.status_flow}  |  ${taskLifecycle.evidence}`);

    // Verify results — always show if ran (critical feedback)
    const vr = taskLifecycle.verify_result as VerifyResult | null;
    if (vr?.results?.length) {
      for (const r of vr.results) {
        const icon = r.passed ? "\u2713" : "\u2717";
        lines.push(`  ${icon} ${r.detail}`);
      }
    }
  }

  // Progress summary
  lines.push(`  ${bar} ${d}\u2713 ${a}> ${t}o of ${total}  |  ${docs} docs`);

  // Auto-sync if schedule=session
  try {
    const syncCfg = getSyncConfig(projectPath);
    const vaultProject = resolveVaultProject(projectPath);
    if (syncCfg.enabled && syncCfg.schedule === "session" && vaultProject && hasGitRepo(vaultProject)) {
      const userIdentity = syncCfg.mode === "team" ? getGitUserIdentity(vaultProject) : undefined;
      const syncResult = syncVault({
        vaultPath: vaultProject,
        conflictStrategy: syncCfg.conflictStrategy,
        branch: syncCfg.branch,
        mode: syncCfg.mode,
        userIdentity,
      });
      if (syncResult.error) {
        lines.push(`  [!] Sync: ${syncResult.error.slice(0, 60)}`);
      } else if (syncResult.conflicts) {
        lines.push("  [!] Sync conflicts — see 08-Execution/Conflict Report.md");
      } else if (!syncResult.skipped) {
        const remoteShort = (syncResult.remote ?? "remote")
          .replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/:/, "/").replace(/\.git$/, "");
        lines.push(`  Synced -> ${remoteShort}`);
      }
    }
  } catch { /* never let sync failure break session end */ }

  // Single "Next:" suggestion — highest priority action only
  const nextActions: string[] = [];

  // 1. Verify failures take top priority
  const vrTop = taskLifecycle?.verify_result as VerifyResult | null;
  if (vrTop && !vrTop.all_passed) {
    nextActions.push(`fix verify failures in ${taskLifecycle!.id as string}`);
  }

  // 2. Architecture files changed → update docs
  if (!nextActions.length && state.docs_touched.length) {
    nextActions.push("/vault:docs  (arch files changed)");
  }

  // 3. Sprint ended → retro
  if (!nextActions.length) {
    try {
      const sprintsPath = path.join(execDir, SPRINTS_DIR);
      if (fs.existsSync(sprintsPath) && fs.statSync(sprintsPath).isDirectory()) {
        for (const fname of fs.readdirSync(sprintsPath)) {
          if (fname.startsWith("Sprint-") && fname.endsWith(".md") && !fname.includes("Retro")) {
            const sc = readFileOrNull(path.join(sprintsPath, fname)) ?? "";
            const { frontmatter: sfm } = parseFrontmatter(sc);
            const endDate = String(sfm.end_date ?? "");
            const sprintNum = String(sfm.number ?? fname.replace("Sprint-", "").replace(".md", ""));
            if (endDate && endDate <= today) {
              const retroFile = path.join(sprintsPath, `Sprint-${sprintNum}-Retro.md`);
              if (!fileExists(retroFile)) {
                nextActions.push(`/vault:retro ${sprintNum}  (sprint ended ${endDate})`);
                break;
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  if (nextActions.length) {
    lines.push(`  Next: ${nextActions[0]}`);
  }

  lines.push(BRAIN_SEP);

  const report = lines.join("\n");

  // Log session end to journal
  let taskNote = "";
  if (taskLifecycle) {
    const tid = taskLifecycle.id as string;
    taskNote = autoCompleted ? ` \u00b7 ${tid} \u2192 DONE` : ` \u00b7 ${tid} in progress`;
  }

  const logEntry =
    `\n## ${today} \u2014 Session ended` +
    ` | ${d}\u2713 ${a}\u25b6 ${t}\u25cb tasks \u00b7 ${docs} docs${taskNote}\n` +
    `- Logged: ${nowIso}\n`;
  const existing = readFileOrNull(journalPath) ?? "";
  atomicWrite(journalPath, existing + logEntry);

  // Cleanup
  cleanupState(projectPath);

  // Output
  process.stdout.write(JSON.stringify({ systemMessage: report }) + "\n");
}

main();
