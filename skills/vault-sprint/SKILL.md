---
name: vault:sprint
description: Manage sprints — create sprints, assign tasks, view progress, and plan work by dates. Use when the user says "sprint", "sprint planning", "create sprint", "sprint progress", or "/vault:sprint".
argument-hint: [create|view|assign] [args]
user-invocable: true
allowed-tools: mcp__vaultops__create_sprint, mcp__vaultops__assign_to_sprint, mcp__vaultops__get_sprint, mcp__vaultops__schedule_task, mcp__vaultops__get_schedule, mcp__vaultops__get_kanban, mcp__vaultops__get_context, mcp__vaultops__get_velocity, mcp__vaultops__get_burndown, mcp__vaultops__generate_canvas
---

# /vault:sprint — Sprint Manager

Create, manage, and track sprints with Agile best practices.

## Modes

### Create mode: `/vault:sprint create`
1. Ask for sprint details: number, start/end dates, goals.
2. Call `create_sprint` with the provided details.
3. Ask which tasks to assign (show kanban board via `get_kanban` for reference).
4. Call `assign_to_sprint` for selected tasks.
5. Optionally schedule tasks across sprint days using `schedule_task`.
6. Generate a canvas board: call `generate_canvas` with `canvas_type: "sprint"` and the sprint number.

### View mode: `/vault:sprint` or `/vault:sprint view` or `/vault:sprint N`
1. Call `get_sprint` with `sprint_number` (or "current" if not specified).
2. Call `get_velocity` for throughput data.
3. Call `get_burndown` for burndown chart data.
4. Show sprint progress with all metrics.

### Assign mode: `/vault:sprint assign EXE-001 EXE-002 to N`
1. Parse task IDs and sprint number from arguments.
2. Call `assign_to_sprint`.
3. Confirm assignment.

### Schedule mode: `/vault:sprint schedule`
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

### Definition of Done ✅
- [ ] Code reviewed and approved
- [ ] Unit tests pass (coverage ≥ threshold)
- [ ] Integration/E2E tests pass
- [ ] Documentation updated (if applicable)
- [ ] No P1 bugs open against sprint tasks
- [ ] Deployed to staging and verified

### Definition of Ready 📋
Before a task enters a sprint, it must have:
- [ ] BA analysis complete (acceptance criteria defined)
- [ ] Dependencies identified and unblocked
- [ ] Complexity estimated (S/M/L/XL)
- [ ] Fits within sprint capacity

### Tasks by Status

**IN_PROGRESS** ({count})
- {EXE-###}: {title} [P1] — scheduled {date}

**TODO** ({count})
- {EXE-###}: {title} [P2] — scheduled {date}

**BLOCKED** ({count})
- {EXE-###}: {title} — blocked by {EXE-###}

### Velocity Trend

```mermaid
xychart-beta
    title "Velocity — Last 3 Sprints"
    x-axis ["Sprint N-2", "Sprint N-1", "Sprint N"]
    y-axis "Tasks Completed" 0 --> {max}
    bar [{val1}, {val2}, {val3}]
```

### Burndown

{Include burndown chart from get_burndown data}
```
