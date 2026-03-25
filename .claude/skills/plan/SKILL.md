---
name: plan
description: Create or update a work plan in Obsidian. Use when starting a new task, feature, or answering "what's the plan".
user-invocable: true
allowed-tools: mcp__vaultops__write_plan, mcp__vaultops__get_context, mcp__vaultops__create_task, mcp__vaultops__log_step
---

# /plan — Work Plan Creator

Help the developer create a structured work plan and save it to Obsidian.

## Steps

1. Call `get_context` to understand current project state and active tasks.
2. If `$ARGUMENTS` is provided, use it as the plan topic. Otherwise ask: "What are we building?"
3. Write a concise plan with:
   - **Goal**: One sentence
   - **Steps**: Numbered checklist (keep it under 10 steps)
   - **Done criteria**: What "done" looks like
   - **Risks**: Only if obvious
4. Call `write_plan` to save it to Work Plans.md.
5. Ask if the user wants to create a task for this plan. If yes, call `create_task`.
6. Call `log_step` to record that a plan was created.

## Output

Show the plan you wrote, then confirm it was saved. If a task was created, show the EXE-### ID.
