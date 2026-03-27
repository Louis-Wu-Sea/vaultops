---
name: vault:replay
description: Session Replay — digest of what happened recently. Shows completed tasks, journal entries, stale docs, and learning events. Use when the user says "what happened", "replay", "catch me up", "status update", or "/vault:replay".
argument-hint: [hours]
user-invocable: true
allowed-tools: mcp__vaultops__get_replay, mcp__vaultops__get_context
---

# /vault:replay — Session Replay

Show a digest of what happened in the project recently.

## Workflow

1. Parse `$ARGUMENTS` for hours (default: 24). Supports "today", "yesterday" (48h), "this week" (168h).
2. Call `get_replay` with the hours parameter.
3. Present the digest clearly — tasks completed, new tasks, journal entries, stale docs, learning events.
4. If stale docs detected, suggest: "Run /vault:docs to update."
5. If tasks are blocked, highlight them.

## When to use

- Starting a new work session ("what happened since yesterday?")
- Returning after time away ("catch me up")
- Daily standup prep ("what did I do?")
- After a teammate asks for status
