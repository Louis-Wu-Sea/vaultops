---
name: vault:standup
description: Quick daily standup capture — what was done, what's next, blockers. Auto-linked to active tasks. Use when the user says "standup", "daily standup", "daily update", or "/vault:standup".
argument-hint: [date]
user-invocable: true
allowed-tools: mcp__vaultops__create_meeting, mcp__vaultops__get_today, mcp__vaultops__get_schedule, Read, Write
---

# /vault:standup — Daily Standup Capture

Quick daily standup note that auto-links to active tasks.

## Workflow

1. Call `get_today` to get active and scheduled tasks.
2. Call `get_schedule` with today's date to see what's due.
3. Create a lightweight meeting note:
   ```
   create_meeting(title="Daily Standup", meeting_type="standup", date=today)
   ```
4. Populate the note with:
   - **Done** — tasks completed since last standup (from task board)
   - **Next** — tasks scheduled for today (from get_schedule)
   - **Blockers** — any BLOCKED tasks
5. Display the standup summary in chat.

## Output Format

```
STANDUP — 2026-03-23

Done:
  - EXE-042: Implement auth flow ✓
  - EXE-043: Fix email parser ✓

Next:
  - EXE-045: Deploy staging (P0, due today)
  - EXE-046: Review PR #123

Blockers:
  - EXE-044: Waiting for API access (BLOCKED)
```
