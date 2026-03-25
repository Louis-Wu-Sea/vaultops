---
name: enrich
description: Orchestrate role-based task enrichment (BA → Designer → SystemAnalyst → Developer → QA). Generates structured analysis for each role. Use when the user says "enrich task", "analyze task", "fill in roles", or "/enrich EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__log_step
---

# /enrich — Role-Based Task Enrichment Orchestrator

Enriches a task with structured analysis from 5 roles in sequence: **BA → Designer → SystemAnalyst → Developer → QA**.

## Workflow

1. Parse `$ARGUMENTS` to extract the task ID (e.g., `EXE-001`). If empty, ask for a task ID.
2. Call `get_task` with the task ID to get current state and completed roles.
3. Identify which roles are already complete and which is the `next_role`.
4. For each incomplete role **in order** (BA first, QA last):
   a. Read outputs from all previously completed roles using `get_role_output` — these form the context.
   b. Generate the role's analysis following the role-specific standards below.
   c. Call `write_role_output` with the generated content.
   d. Report progress: `✓ {role} complete for {task_id}`
5. After all roles are done, call `log_step` to record completion.
6. Output final summary showing all 5 role statuses.

## Role Standards

### BA (Business Analyst)
Generate: user stories (As a... I want... So that...), acceptance criteria (Given/When/Then), business rules, scope boundaries, stakeholders affected.

### Designer
Generate: UX flow description (step-by-step user journey), component inventory (UI elements needed), interaction patterns (hover, click, transitions), accessibility notes (ARIA, contrast, keyboard nav).

### SystemAnalyst
Generate: technical specification, data model changes (entities, fields, relationships), API contracts (endpoints, request/response schemas), integration points (external services, internal modules), performance considerations.

### Developer
Generate: implementation plan (ordered steps), files to create/modify (with paths), architecture decisions (patterns, libraries), risks and unknowns, estimated complexity (S/M/L).

### QA
Generate: test strategy, test cases for each acceptance criterion (unit, integration, E2E), edge cases, regression risks, environment requirements.

## Gate Rules

- Roles MUST execute in order: BA → Designer → SystemAnalyst → Developer → QA.
- Each role receives the output of ALL previous roles as input context.
- If a role is already complete (status: complete), skip it.
- User can restart a specific role by calling the individual role skill (e.g., `/ba EXE-001`).

## Output Format

```
## Enrichment Summary — {task_id}: {task_title}

| Role | Status |
|------|--------|
| BA | ✓ Complete |
| Designer | ✓ Complete |
| SystemAnalyst | ✓ Complete |
| Developer | ✓ Complete |
| QA | ✓ Complete |

All role outputs saved to vault. View in Obsidian: `08-Execution/Role Outputs/{task_id}/`
```
