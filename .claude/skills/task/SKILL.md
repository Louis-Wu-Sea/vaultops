---
name: task
description: Create a new task in Obsidian Task Board with auto-incremented EXE-### ID, or update an existing task. Supports sub-tasks, dependencies, and scheduling. Use when the user says "create task", "new task", "track this", "link tasks".
argument-hint: <title> or <EXE-### STATUS>
user-invocable: true
allowed-tools: mcp__vaultops__create_task, mcp__vaultops__update_task, mcp__vaultops__log_step, mcp__vaultops__link_tasks, mcp__vaultops__get_task
---

# /task — Task Creator & Manager

Create, update, or link tasks in the Obsidian Task Board.

## Create mode (default)

1. Use `$ARGUMENTS` as the task title. If empty, ask for a title.
2. Ask if the user wants to specify: priority (P1-P3), tags, scheduled_date, or parent_task (for sub-tasks).
3. Call `create_task` with all provided fields. This creates both a Task Board row AND an individual task file with YAML frontmatter.
4. Call `log_step` to record the task creation.
5. Output: `Created **{EXE-###}**: {title}` and mention `/enrich {EXE-###}` to generate role-based analysis.

## Update mode

If `$ARGUMENTS` starts with `EXE-` (e.g., `/task EXE-001 DONE`), parse as update:
1. Extract task ID and new status from arguments.
2. Call `update_task` with the ID and status (syncs to both Task Board and task file).
3. Call `log_step` to record the status change.
4. Output: `Updated **{EXE-###}** → {status}`

## Link mode

If `$ARGUMENTS` contains "link" or "depends" (e.g., `/task link EXE-001 blocked-by EXE-002`):
1. Parse source task, target task, and relationship type.
2. Call `link_tasks` to create the dependency.
3. Output: `Linked **{source}** —{relationship}→ **{target}**`

## Sub-task mode

If `$ARGUMENTS` contains "sub" or "subtask" (e.g., `/task sub EXE-001 Fix validation`):
1. Parse parent task ID and sub-task title.
2. Call `create_task` with `parent_task` set.
3. Output: `Created sub-task **{EXE-001.1}**: {title} (parent: {EXE-001})`
