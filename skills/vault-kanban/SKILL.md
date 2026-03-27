---
name: vault:kanban
description: Show task board as a Kanban view with columns grouped by status. Use when the user says "kanban", "board", "show tasks", "task overview".
user-invocable: true
allowed-tools: mcp__vaultops__get_kanban
---

# /vault:kanban — Kanban Board View

Display the Obsidian Task Board grouped by status columns.

## Steps

1. Call `get_kanban` with the current project path.
2. Render the board as a formatted view.

## Output format

```
## Kanban — {project} ({counts summary})

### IN_PROGRESS ({count})
- {EXE-###}: {title} [{priority}]

### TODO ({count})
- {EXE-###}: {title} [{priority}]

### BLOCKED ({count})
- {EXE-###}: {title} [{priority}]

### DONE ({count})
- {EXE-###}: {title}
```

If DONE has more than 10 items, show only the 5 most recent and note "... and {N} more".
Keep it clean and scannable.
