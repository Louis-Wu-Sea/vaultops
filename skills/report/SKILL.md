---
name: vault:report
description: Generate standalone HTML report for stakeholders — donut chart, task table, velocity metrics. Zero dependencies, shareable as a file. Use when the user says "report", "stakeholder", "status report", or "/vault:report".
argument-hint: [sprint_number]
user-invocable: true
allowed-tools: mcp__vaultops__generate_report
---

# /vault:report — Stakeholder Report

Generate a beautiful standalone HTML report that non-technical stakeholders can view in any browser.

## Workflow

1. Parse `$ARGUMENTS` for sprint number (optional).
2. Call `generate_report` with sprint_number and optional output_path.
3. Tell the user where the file was saved and how to open it.

## Output

A single HTML file with:
- SVG donut chart showing completion percentage
- Status cards (Done, In Progress, Blocked, To Do)
- Task table with status badges
- Velocity metrics
- Zero external dependencies — works offline

## When to use

- Sharing progress with PM/manager who won't open Obsidian
- Sprint review presentation
- Status update email attachment
- Client-facing deliverable
