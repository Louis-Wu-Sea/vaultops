---
name: vault:task
description: Create a new task in Obsidian Task Board with auto-incremented EXE-### ID, or update an existing task. Supports sub-tasks, dependencies, scheduling, and Task-as-Code verify contracts. Use when the user says "create task", "new task", "track this", "link tasks", "verify task".
argument-hint: <title> or <EXE-### STATUS> or verify <EXE-###>
user-invocable: true
allowed-tools: mcp__vaultops__create_task, mcp__vaultops__update_task, mcp__vaultops__log_step, mcp__vaultops__link_tasks, mcp__vaultops__get_task, mcp__vaultops__run_verify
---

# /vault:task — Task Creator & Manager

Create, update, link, or verify tasks in the Obsidian Task Board.

## Create mode (default)

1. Use `$ARGUMENTS` as the task title. If empty, ask for a title.
2. Ask if the user wants to specify: priority (P1-P3), tags, scheduled_date, parent_task, or **verify checks**.
3. Call `create_task` with all provided fields. This creates both a Task Board row AND an individual task file with YAML frontmatter.
4. Call `log_step` to record the task creation.
5. Output: `Created **{EXE-###}**: {title}` and mention `/vault:enrich {EXE-###}` to generate role-based analysis.

### Task-as-Code: verify checks

When creating a task, you can define a **completion contract** — a list of checks that must pass before the task can be auto-completed. Pass the `verify` parameter with an array of check objects:

```json
"verify": [
  {"type": "file_exists", "path": "src/auth/middleware.ts"},
  {"type": "file_changed", "path": "src/auth/*.ts"},
  {"type": "grep_content", "path": "src/auth/middleware.ts", "pattern": "validateToken"},
  {"type": "test_pattern", "pattern": "src/auth/**/*.test.ts"}
]
```

**Check types:**
- `file_exists` — file/directory must exist (relative to project root)
- `file_changed` — file must be edited during the session (glob supported)
- `grep_content` — file must contain regex pattern
- `test_pattern` — test files matching glob must exist

When the session ends, auto-complete runs these checks. If any check fails, the task stays IN_PROGRESS with a detailed report of what failed. This ensures task = contract, not just "I committed something".

## Update mode

If `$ARGUMENTS` starts with `EXE-` (e.g., `/vault:task EXE-001 DONE`), parse as update:
1. Extract task ID and new status from arguments.
2. Call `update_task` with the ID and status (syncs to both Task Board and task file).
3. Call `log_step` to record the status change.
4. Output: `Updated **{EXE-###}** → {status}`

## Verify mode

If `$ARGUMENTS` contains "verify" (e.g., `/vault:task verify EXE-001`):
1. Extract task ID from arguments.
2. Call `run_verify` to execute all verify checks defined in the task's frontmatter.
3. Output: pass/fail for each check with details.

## Link mode

If `$ARGUMENTS` contains "link" or "depends" (e.g., `/vault:task link EXE-001 blocked-by EXE-002`):
1. Parse source task, target task, and relationship type.
2. Call `link_tasks` to create the dependency.
3. Output: `Linked **{source}** —{relationship}→ **{target}**`

## Sub-task mode

If `$ARGUMENTS` contains "sub" or "subtask" (e.g., `/vault:task sub EXE-001 Fix validation`):
1. Parse parent task ID and sub-task title.
2. Call `create_task` with `parent_task` set.
3. Output: `Created sub-task **{EXE-001.1}**: {title} (parent: {EXE-001})`
