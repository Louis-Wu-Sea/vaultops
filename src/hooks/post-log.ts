/**
 * VaultOps Brain — PostToolUse hook.
 *
 * Fires after Edit/Write/Bash tools. Logs execution steps, collects
 * evidence from test runs and git commits, and auto-updates task evidence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  isVaultopsProject,
  loadState,
  saveState,
  isTestCommand,
  isCommitCommand,
  extractTestResults,
  extractCommitSha,
  extractCommitMessage,
} from "./shared/brain-state.js";
import { logStep, updateTask } from "../tools/core.js";
import { getProjectDna } from "../tools/adaptive.js";
import { ROLE_OUTPUTS_DIR } from "../constants.js";

function main(): void {
  const projectPath = process.cwd();

  if (!isVaultopsProject(projectPath)) return;

  // Read hook input from stdin
  let hookInput: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(0, "utf-8");
    hookInput = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = String(hookInput.tool_name ?? "");
  const toolInput = (hookInput.tool_input ?? {}) as Record<string, string>;
  const toolResult = hookInput.tool_result;

  const state = loadState(projectPath);

  // If suppressed, skip
  if (state.suppressed) return;

  // Build log message based on tool type
  let message = "";
  let evidenceUpdate = "";

  if (toolName === "Edit") {
    const filePath = toolInput.file_path ?? "unknown";
    message = `Edited ${path.basename(filePath)}`;
  } else if (toolName === "Write") {
    const filePath = toolInput.file_path ?? "unknown";
    message = `Created/wrote ${path.basename(filePath)}`;
  } else if (toolName === "Bash") {
    const command = toolInput.command ?? "";
    const output = toolResult ? String(toolResult).slice(0, 3000) : "";

    // Test evidence collection
    if (isTestCommand(command)) {
      state.tests_run = true;
      const [isTest, passed, summary] = extractTestResults(output);
      if (isTest) {
        state.tests_passed = passed;
        message = `Ran tests: ${summary}`;
        evidenceUpdate = summary;
      }
    } else if (isCommitCommand(command)) {
      // Commit evidence collection
      const sha = extractCommitSha(output);
      if (sha) {
        const commitMsg = extractCommitMessage(output);
        state.commits.push({ sha, message: commitMsg });
        message = `Committed ${sha}`;
        if (commitMsg) message += `: ${commitMsg.slice(0, 50)}`;
        evidenceUpdate = `Commit ${sha}`;
        if (commitMsg) evidenceUpdate += `: ${commitMsg.slice(0, 40)}`;
      }
    } else {
      // Generic bash — short summary
      const cmdShort = command.split("\n")[0].slice(0, 60);
      message = `Ran: ${cmdShort}`;
    }
  }

  // Log to Execution Journal
  if (message) {
    try {
      logStep({ project_path: projectPath, message });
    } catch { /* ignore */ }
  }

  // Auto-update task evidence
  if (evidenceUpdate && state.active_task_id) {
    try {
      updateTask({
        project_path: projectPath,
        task_id: state.active_task_id,
        evidence: evidenceUpdate,
      });
    } catch { /* ignore */ }
  }

  // Auto: Test failure warning
  const outputLines: string[] = [];
  if (state.tests_passed === false && state.active_task_id) {
    outputLines.push(
      `[VaultOps] Tests failed. ${state.active_task_id} will NOT auto-complete until tests pass.`
    );
  }

  // Auto: Enrichment counter → DNA rebuild
  if (toolName === "Write") {
    const filePath = toolInput.file_path ?? "";
    if (filePath.includes(ROLE_OUTPUTS_DIR) && filePath.endsWith(".md")) {
      const count = (state.enrichment_count ?? 0) + 1;
      state.enrichment_count = count;
      // Rebuild DNA every 5 enrichments
      if (count % 5 === 0) {
        try {
          getProjectDna({ project_path: projectPath });
          outputLines.push(
            `[VaultOps] Project DNA auto-updated (${count} enrichments analyzed).`
          );
        } catch { /* ignore */ }
      }
    }
  }

  saveState(projectPath, state);

  if (outputLines.length) {
    process.stdout.write(JSON.stringify({ additionalContext: outputLines.join("\n") }) + "\n");
  }
}

main();
