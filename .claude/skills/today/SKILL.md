---
name: today
description: Show today's tasks from Obsidian Task Board. Shows scheduled tasks for today, overdue tasks, and active work. Use when starting work, checking status, or asking "what should I work on".
user-invocable: true
allowed-tools: mcp__vaultops__get_today, mcp__vaultops__get_context, mcp__vaultops__get_schedule
---

# /today — Daily Task Dashboard

Show what to work on today.

## Workflow

1. Detect the current project path from the working directory.
2. Call `get_schedule` with today's date to get:
   - Tasks scheduled for today
   - Overdue tasks (scheduled before today, not DONE)
3. Call `get_today` to get all active tasks (IN_PROGRESS, BLOCKED, TODO).
4. Call `get_context` to show the current project stage.

## Output Format

```
## Today — {project} ({date})

### Current Stage
{brief stage summary — one line}

### ⚠️ Overdue ({count})
{overdue tasks with original scheduled dates — these need attention first}

### Scheduled for Today ({count})
{tasks explicitly planned for today}

### Active Work
{IN_PROGRESS tasks — current focus}

### Blocked
{BLOCKED tasks — note what's blocking them}

### Up Next
{TODO tasks — pick from these when current work is done}
```

## Rules

- If there are overdue tasks, highlight them prominently at the top.
- Highlight the FIRST IN_PROGRESS task as the current focus.
- If no tasks are scheduled for today, show the active tasks as fallback.
- If no tasks exist at all, suggest: `Use /task to create your first task, or /plan to plan your work.`
- Keep output scannable — one line per task.
- If `get_schedule` returns an error (no task files yet), fall back to `get_today` only.
