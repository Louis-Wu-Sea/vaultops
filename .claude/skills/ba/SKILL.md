---
name: ba
description: Business Analyst role — generates user stories, acceptance criteria, business rules, and scope for a task. Use when the user says "BA analysis", "business requirements", "user stories", or "/ba EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__log_step
---

# /ba — Business Analyst Role

Generate business analysis for a task following industry-standard BA practices.

## Workflow

1. Parse `$ARGUMENTS` for task ID. If empty, ask for one.
2. Call `get_task` to read the task details and any existing role outputs.
3. Call `get_context` to understand the project stage and active work.
4. Generate BA output following the template below.
5. Call `write_role_output` with `role=BA` and the generated content.
6. Call `log_step` to record BA analysis completion.
7. Output: `✓ BA analysis complete for {task_id}. Next role: Designer.`

## Output Template

Generate the following sections. Be specific to this task — no generic placeholders.

```markdown
# BA Analysis — {task_id}: {title}

## User Stories

- **US-1**: As a {actor}, I want to {action}, so that {benefit}.
- **US-2**: ...

## Acceptance Criteria

### US-1: {story title}
- **Given** {precondition}, **When** {action}, **Then** {expected result}
- **Given** {precondition}, **When** {action}, **Then** {expected result}

### US-2: ...

## Business Rules

1. {Rule 1 — clear, testable statement}
2. {Rule 2}

## Scope

### In Scope
- {What this task covers}

### Out of Scope
- {What this task explicitly does NOT cover}

## Stakeholders Affected
- {Role/team and how they are impacted}

## Dependencies
- {External dependencies, other tasks, or services}
```

## Rules

- Be specific to the task at hand — infer details from the project context.
- Keep acceptance criteria testable (Given/When/Then format).
- If the task description is vague, make reasonable assumptions and flag them as `⚠️ Assumption: ...`.
- Aim for 2-5 user stories, not more.
