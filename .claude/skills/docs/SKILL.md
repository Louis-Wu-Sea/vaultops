---
name: docs
description: Generate or update project documentation in Obsidian vault. Use when the user says "generate docs", "document this project", "fill in docs".
user-invocable: true
allowed-tools: mcp__vaultops__generate_docs_prompt, Read, Write, Glob, Grep, mcp__vaultops__log_step
---

# /docs — Documentation Generator

Scan the project and generate documentation for empty Obsidian vault sections.

## Steps

1. Call `generate_docs_prompt` with the project path.
2. Review the returned section status and prompt.
3. For sections marked MISSING or EMPTY:
   - Read key project files (README.md, package.json, main entry points) to gather context.
   - Generate concise documentation for each section.
   - Write the generated files to the vault using the Write tool.
4. Call `log_step` to record what was generated.

## Section priorities

Focus on these first (most valuable):
1. **00-Overview/System Architecture.md** — tech stack, component diagram
2. **04-Development/Codebase Map.md** — key directories, entry points
3. **06-Operations/Runbook.md** — how to run, deploy, debug
4. **01-Requirements/Product Goals.md** — what the product does

Skip these unless asked: 02-Research, 03-Design, 05-QA, 07-References.

## Output

List what was generated and where. Keep each doc file concise (200-400 words).
