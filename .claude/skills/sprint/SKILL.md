---
name: sprint
description: Manage sprints — create sprints, assign tasks, view progress, and plan work by dates. Use when the user says "sprint", "sprint planning", "create sprint", "sprint progress", or "/sprint".
argument-hint: [create|view|assign] [args]
user-invocable: true
allowed-tools: mcp__vaultops__create_sprint, mcp__vaultops__assign_to_sprint, mcp__vaultops__get_sprint, mcp__vaultops__schedule_task, mcp__vaultops__get_schedule, mcp__vaultops__get_kanban, mcp__vaultops__get_context
---

# /sprint — Sprint Manager

Create, manage, and track sprints.

## Modes

### Create mode: `/sprint create`
1. Ask for sprint details: number, start/end dates, goals.
2. Call `create_sprint` with the provided details.
3. Ask which tasks to assign (show kanban board via `get_kanban` for reference).
4. Call `assign_to_sprint` for selected tasks.
5. Optionally schedule tasks across sprint days using `schedule_task`.

### View mode: `/sprint` or `/sprint view` or `/sprint N`
1. Call `get_sprint` with `sprint_number` (or "current" if not specified).
2. Show sprint progress:
   - Goals with completion status
   - Task list grouped by status
   - Progress percentage
   - Days remaining

### Assign mode: `/sprint assign EXE-001 EXE-002 to N`
1. Parse task IDs and sprint number from arguments.
2. Call `assign_to_sprint`.
3. Confirm assignment.

### Schedule mode: `/sprint schedule`
1. Call `get_sprint` for current sprint to see unscheduled tasks.
2. For each unscheduled task, suggest a date based on:
   - Priority (P1 tasks earlier)
   - Dependencies (blocked tasks after their blockers)
   - Workload distribution (spread across days)
3. Call `schedule_task` for each suggestion the user approves.

## Output Format

```
## Sprint {N}: {start} — {end}

**Progress**: {pct}% ({done}/{total} tasks) | {days_remaining} days left

### Goals
- [x] {completed goal}
- [ ] {pending goal}

### Tasks by Status

**IN_PROGRESS** ({count})
- {EXE-###}: {title} [P1] — scheduled {date}

**TODO** ({count})
- {EXE-###}: {title} [P2] — scheduled {date}

**BLOCKED** ({count})
- {EXE-###}: {title} — blocked by {EXE-###}
```
