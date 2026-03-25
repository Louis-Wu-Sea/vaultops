/**
 * Adaptive Roles tool (Group F): get_project_dna
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolArgs, ToolResult } from "../types.js";
import { readFileOrNull } from "../fs/read.js";
import { atomicWrite } from "../fs/write.js";
import { execPath } from "../vault/resolve.js";
import { ROLE_OUTPUTS_DIR, VALID_ROLES } from "../constants.js";
import { toolResult } from "./helpers.js";

const PROJECT_DNA_FILE = "Project DNA.md";

export function getProjectDna(args: ToolArgs): ToolResult {
  const projectPath = (args.project_path as string) || ".";

  const [execDir, err] = execPath(projectPath);
  if (err) return toolResult({ error: err }, true);

  const sharedDir = path.join(path.dirname(execDir!), "_shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  const dnaPath = path.join(sharedDir, PROJECT_DNA_FILE);

  // Analyze role outputs
  const roleDir = path.join(execDir!, ROLE_OUTPUTS_DIR);
  const roleData: Record<string, string[]> = {};
  for (const r of VALID_ROLES) roleData[r] = [];
  let taskCount = 0;

  try {
    if (fs.statSync(roleDir).isDirectory()) {
      for (const taskDirName of fs.readdirSync(roleDir)) {
        const taskRoleDir = path.join(roleDir, taskDirName);
        try { if (!fs.statSync(taskRoleDir).isDirectory()) continue; } catch { continue; }
        taskCount++;
        for (const roleFile of fs.readdirSync(taskRoleDir)) {
          if (!roleFile.endsWith(".md")) continue;
          const roleName = roleFile.replace(".md", "");
          if (roleName in roleData) {
            roleData[roleName].push(readFileOrNull(path.join(taskRoleDir, roleFile)) ?? "");
          }
        }
      }
    }
  } catch { /* skip */ }

  if (taskCount === 0) {
    return toolResult({ status: "no_data", message: "No role outputs found. Run /vault:enrich on a few tasks first." });
  }

  const patterns: Record<string, string[]> = {};

  // Detect tech stack from Developer outputs
  const stackKeywords: Record<string, number> = {};
  const techPatterns = [
    /\b(React|Vue|Angular|Svelte|Next\.?js|NestJS|Express|Fiber|Gin|Django|Flask)\b/gi,
    /\b(TypeScript|Go|Python|Rust|Java|Kotlin)\b/gi,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|Prisma|SQLAlchemy|GORM)\b/gi,
    /\b(Jest|Vitest|Playwright|pytest|go test|Mocha)\b/gi,
    /\b(Tailwind|shadcn|MUI|Chakra|Bootstrap)\b/gi,
    /\b(Docker|Kubernetes|Vercel|AWS|GCP)\b/gi,
  ];
  for (const output of roleData.Developer ?? []) {
    for (const pattern of techPatterns) {
      for (const m of output.matchAll(pattern)) {
        const key = m[1];
        stackKeywords[key] = (stackKeywords[key] ?? 0) + 1;
      }
    }
  }
  const stack = Object.entries(stackKeywords)
    .filter(([, v]) => v >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  patterns.stack = stack.map(([k, v]) => `${k} (x${v})`);

  // Detect testing patterns from QA outputs
  const testPatternsFound = new Set<string>();
  for (const output of roleData.QA ?? []) {
    if (/unit test|юнит/i.test(output)) testPatternsFound.add("unit tests");
    if (/e2e|end-to-end|playwright|cypress/i.test(output)) testPatternsFound.add("e2e tests");
    if (/integration|интеграц/i.test(output)) testPatternsFound.add("integration tests");
    if (/BDD|Gherkin|Given.*When.*Then/i.test(output)) testPatternsFound.add("BDD/Gherkin");
    if (/table.driven|table test/i.test(output)) testPatternsFound.add("table-driven tests");
  }
  patterns.testing = [...testPatternsFound];

  // Detect design patterns
  const designPatternsFound = new Set<string>();
  for (const output of roleData.Designer ?? []) {
    if (/WCAG|accessibility|a11y/i.test(output)) designPatternsFound.add("WCAG/a11y focus");
    if (/dark mode|theme/i.test(output)) designPatternsFound.add("theme support");
    if (/responsive|mobile.first/i.test(output)) designPatternsFound.add("responsive/mobile-first");
    if (/component|storybook/i.test(output)) designPatternsFound.add("component-driven");
  }
  patterns.design = [...designPatternsFound];

  // Role usage stats
  const roleStats: Record<string, number> = {};
  for (const [role, outputs] of Object.entries(roleData)) {
    if (outputs.length) roleStats[role] = outputs.length;
  }
  const roleOrder = Object.entries(roleStats).sort((a, b) => b[1] - a[1]);
  patterns.role_usage = roleOrder.map(([r, c]) => `${r}: ${c} outputs`);

  // Build DNA content
  const now = new Date().toISOString().slice(0, 10);
  const stackYaml = stack.length ? "[" + stack.map(([k]) => k).join(", ") + "]" : "[]";
  const testingYaml = "[" + (patterns.testing ?? []).join(", ") + "]";
  const designYaml = "[" + (patterns.design ?? []).join(", ") + "]";
  const confidence = taskCount >= 10 ? "high" : taskCount >= 5 ? "medium" : "low";

  const dnaContent = `---
generated: ${now}
tasks_analyzed: ${taskCount}
confidence: ${confidence}
tags: [vaultops/dna, vaultops/adaptive]
---

# Project DNA

> Auto-generated profile from ${taskCount} enriched tasks. Used by role skills to adapt their output.

## Tech Stack

${(patterns.stack ?? ["(not enough data)"]).map((s) => `- ${s}`).join("\n")}

## Testing Style

${(patterns.testing ?? ["(not enough data)"]).map((t) => `- ${t}`).join("\n")}

## Design Patterns

${(patterns.design ?? ["(not enough data)"]).map((d) => `- ${d}`).join("\n")}

## Role Usage

${(patterns.role_usage ?? []).map((r) => `- ${r}`).join("\n")}

## Adaptive Rules

> These rules are auto-extracted from your enrichment history. Edit to customize.

- Stack detected: ${stackYaml}
- Test frameworks: ${testingYaml}
- Design approach: ${designYaml}
`;

  atomicWrite(dnaPath, dnaContent);

  return toolResult({
    file: dnaPath,
    tasks_analyzed: taskCount,
    stack: stack.map(([k]) => k),
    testing: patterns.testing ?? [],
    design: patterns.design ?? [],
    role_usage: roleStats,
    confidence,
  });
}
