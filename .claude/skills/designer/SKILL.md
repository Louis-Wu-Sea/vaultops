---
name: designer
description: Designer role — generates UX flows, component inventory, interaction patterns, and accessibility notes for a task. Use when the user says "design analysis", "UX flow", "UI components", or "/designer EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__log_step
---

# /designer — Designer Role

Generate UX/UI design analysis for a task based on BA output.

## Workflow

1. Parse `$ARGUMENTS` for task ID. If empty, ask for one.
2. Call `get_task` to read task details and existing role outputs.
3. Call `get_role_output` with `role=BA` to get the BA analysis as input context.
4. If BA output doesn't exist, warn: `⚠️ BA analysis not found. Running without BA context — results may be less accurate.`
5. Generate Designer output following the template below.
6. Call `write_role_output` with `role=Designer` and the generated content.
7. Call `log_step` to record completion.
8. Output: `✓ Designer analysis complete for {task_id}. Next role: SystemAnalyst.`

## Output Template

```markdown
# Design Analysis — {task_id}: {title}

## User Flow

1. **Entry Point**: {How user arrives at this feature}
2. **Step 1**: {User action} → {System response}
3. **Step 2**: {User action} → {System response}
4. **Happy Path Exit**: {Successful completion state}
5. **Error Path**: {What happens on failure}

## Component Inventory

| Component | Type | Purpose | Existing? |
|-----------|------|---------|-----------|
| {Name} | {Button/Form/Modal/List/...} | {What it does} | {Yes — path, or No — create} |

## Interaction Patterns

- **{Pattern}**: {Description of hover/click/transition/animation behavior}

## Layout Notes

- {Responsive behavior, breakpoints, positioning}

## Accessibility

- **Keyboard**: {Tab order, keyboard shortcuts}
- **Screen Reader**: {ARIA labels, roles, live regions}
- **Visual**: {Contrast, focus indicators, motion preferences}

## States

| State | Description | UI Treatment |
|-------|-------------|-------------|
| Empty | {No data yet} | {Empty state message/illustration} |
| Loading | {Fetching data} | {Skeleton/spinner} |
| Error | {Failed to load} | {Error message + retry} |
| Success | {Normal with data} | {Default view} |
```

## Rules

- Reference BA user stories when describing flows.
- Flag which components already exist in the codebase vs need to be created.
- Keep interaction descriptions concrete, not abstract.
- Always include empty, loading, error, and success states.
