---
name: vault:meeting
description: Create, process, or review meeting notes. Dispatches action items to project task boards, links decisions to ADRs, and manages follow-ups. Use when the user says "meeting", "meeting notes", "action items", "dispatch items", or "/vault:meeting".
argument-hint: <title> | process <MTG-###> | dashboard
user-invocable: true
allowed-tools: mcp__vaultops__create_meeting, mcp__vaultops__get_meeting, mcp__vaultops__dispatch_action_items, mcp__vaultops__link_decision_to_adr, mcp__vaultops__create_followup, mcp__vaultops__get_meeting_dashboard, mcp__vaultops__get_meeting_series, mcp__vaultops__create_task, mcp__vaultops__log_step, Read, Write
---

# /vault:meeting — Meeting Notes Manager

Create, process, and review meeting notes with automatic action item dispatch to project task boards.

## Modes

### 1. Create a meeting (`/vault:meeting <title>`)

1. Parse the title and optional flags from arguments.
2. Call `create_meeting` with title, date, meeting_type, series, participants, projects.
3. If the user provides a transcript or notes, write them into the meeting note file using Write tool.
4. Display the created meeting ID and file path.

### 2. Process a meeting (`/vault:meeting process MTG-###`)

This is the most powerful mode — it turns meeting decisions into tracked work:

1. Call `get_meeting` to read the full meeting note.
2. Call `dispatch_action_items` with `dry_run: true` first to show proposed task assignments.
3. Ask the user to confirm the dispatch.
4. Call `dispatch_action_items` with `dry_run: false` to create tasks.
5. For each decision in the "Decisions Made" section:
   - Ask if it should be linked to an ADR.
   - Call `link_decision_to_adr` for confirmed decisions.
6. For items in "Follow-up for Next Meeting":
   - Call `create_followup` with appropriate due dates.
7. Log the processing step to execution journal.

### 3. Dashboard (`/vault:meeting dashboard`)

1. Call `get_meeting_dashboard` to get recent meetings, undispatched items, overdue follow-ups.
2. Format as a clear overview:
   - Recent meetings with TL;DR
   - Undispatched meetings (needs `/vault:meeting process`)
   - Overdue follow-ups (needs attention)
   - Upcoming series

### 4. Series management (`/vault:meeting series create <name>`)

1. Call `get_meeting_series` with action=create.
2. Set cadence, default participants, and default projects.

## Meeting Note Structure

Notes live at `{vault_root}/_meetings/Notes/` with YAML frontmatter:
- `meeting_id`: MTG-### (auto-incremented)
- `status`: draft → final → processed
- `action_items_dispatched`: false → true (after dispatch)

## Tips

- Always run `dispatch_action_items` with `dry_run: true` first to review assignments.
- Use `series` parameter to auto-fill participants and projects for recurring meetings.
- Action items tagged `meeting/MTG-###` can be found via `/vault:today`.
- Follow-ups tagged `followup/MTG-###` surface in overdue lists.
