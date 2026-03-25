---
name: context
description: Show full project context — current stage, active tasks, recent journal, and scope verification. Use when the user says "context", "what's going on", "project status", "check context", or "/context".
user-invocable: true
allowed-tools: mcp__vaultops__get_context, mcp__vaultops__get_today, mcp__vaultops__get_sprint, mcp__vaultops__get_kanban, mcp__vaultops__log_step
---

# /context — Project Context Verifier

Show full project context and verify current work aligns with active tasks.

## Workflow

1. Call `get_context` to get current stage, task summary, active/blocked tasks.
2. Call `get_kanban` for full board overview.
3. Try `get_sprint` with `sprint_number=current` (skip if no sprints exist).
4. Display structured context overview.

## Output Format

```
## Project Context — {project}

### Stage
{current stage summary}

### Active Sprint
Sprint {N}: {start} — {end} | {pct}% complete | {days_remaining} days left

### Task Overview
| Status | Count |
|--------|-------|
| Done | {n} |
| In Progress | {n} |
| Blocked | {n} |
| TODO | {n} |

### Current Focus
{IN_PROGRESS tasks with details}

### Blockers
{BLOCKED tasks with what's blocking them}

### Context State
{decision context snapshot}
```

## Scope Verification

After showing context, check if recent conversation topics align with any active task:
- If YES: confirm alignment — "You're working on {EXE-###}: {title}"
- If NO active tasks: suggest "Consider creating a task with /task before starting work"
- If work doesn't match any task: warn "Current work doesn't match any tracked task. Create one with /task?"
