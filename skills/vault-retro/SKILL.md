---
name: vault:retro
description: Generate a data-driven sprint retrospective with auto-detected insights — cycle time analysis, role enrichment impact, verify contract results, and pattern detection. Use when the user says "retrospective", "retro", "sprint review", or "/vault:retro N".
argument-hint: <sprint_number>
user-invocable: true
allowed-tools: mcp__vaultops__get_sprint, mcp__vaultops__get_velocity, mcp__vaultops__get_burndown, mcp__vaultops__generate_retro, mcp__vaultops__log_step
---

# /vault:retro — Generative Sprint Retrospective

Generate a data-driven retrospective that auto-analyzes sprint performance.

## What's auto-detected

The retro generator analyzes real data from the sprint:

- **Cycle time outliers**: Fastest and slowest tasks vs average
- **Role enrichment impact**: Whether tasks with BA/Designer/Dev/QA analysis completed faster
- **Verify contracts**: How many tasks had Task-as-Code contracts, how many blocked premature completion
- **Blocked/carried tasks**: Identifies unfinished work and bottlenecks
- **Completion rate assessment**: Flags over-commitment or strong execution
- **Learning system events**: User corrections, brain calibration status
- **Per-task breakdown table**: Status, cycle time, roles used, verify status

## Workflow

1. Parse `$ARGUMENTS` for sprint number. If empty, ask for one.
2. Call `generate_retro` with the sprint number — this creates the retro file with auto-generated insights.
3. Call `get_sprint` to show the full sprint summary.
4. Call `get_velocity` for trend data.
5. Present the auto-detected insights to the user:
   - **What went well** — auto-populated with speed records, high completion rates
   - **What didn't go well** — auto-populated with blockers, slow tasks, carry-over
   - **Patterns** — auto-populated with enrichment impact, verify adoption
6. Guide the user to add their own observations to each section.
7. Help create SMART action items based on the data.
8. Call `log_step` to record the retrospective.

## Output

Show the generated retro with emphasis on the auto-detected sections. Highlight surprises — tasks that were unexpectedly fast/slow, role enrichment impact.

## Rules

- Always show metrics first — data-driven retrospectives are more productive.
- Present auto-detected insights as conversation starters, not conclusions.
- Ask the user to confirm/deny each insight — "Does this match your experience?"
- Keep action items SMART: Specific, Measurable, Achievable, Relevant, Time-bound.
- Link back to the sprint file: `[[Sprint-{N}]]`.
