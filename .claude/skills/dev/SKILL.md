---
name: dev
description: Developer role — generates implementation plan, files to modify, architecture decisions, and complexity estimate for a task. Use when the user says "implementation plan", "dev plan", "how to implement", or "/dev EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__log_step, Glob, Grep, Read
---

# /dev — Developer Role

Generate implementation plan for a task based on all previous role outputs AND actual codebase analysis.

## Workflow

1. Parse `$ARGUMENTS` for task ID. If empty, ask for one.
2. Call `get_task` to read task details and existing role outputs.
3. Call `get_role_output` for `BA`, `Designer`, and `SystemAnalyst` roles.
4. **Scan the codebase** using Glob/Grep/Read to find:
   - Existing files that will need changes
   - Patterns and conventions used in the project
   - Related existing implementations to reference
5. Generate Developer output following the template below.
6. Call `write_role_output` with `role=Developer` and the generated content.
7. Call `log_step` to record completion.
8. Output: `✓ Developer analysis complete for {task_id}. Next role: QA.`

## Output Template

```markdown
# Implementation Plan — {task_id}: {title}

## Summary

{1-2 sentences on implementation approach}

## Complexity: {S | M | L | XL}
- **Estimated scope**: {N files to create, M files to modify}
- **Risk level**: {Low/Medium/High} — {why}

## Implementation Steps

### Step 1: {Description}
- **Files**: `{path/to/file.ext}` — {create | modify}
- **What**: {Specific changes}
- **Why**: {Rationale}

### Step 2: {Description}
- **Files**: `{path/to/file.ext}`
- **What**: {Specific changes}
- **Why**: {Rationale}

## Files to Create

| File | Purpose | Based On |
|------|---------|----------|
| `{path}` | {What it does} | {Existing pattern/file to reference} |

## Files to Modify

| File | Change | Lines/Section |
|------|--------|---------------|
| `{path}` | {What changes} | {Approximate location} |

## Architecture Decisions

- **{Decision}**: {Chosen approach} over {alternative} because {reason}.

## Dependencies

- [ ] {External library/package to install}
- [ ] {Other task that must be completed first}

## Risks & Unknowns

- ⚠️ {Risk description and mitigation}

## Code Patterns to Follow

Reference these existing implementations for consistency:
- `{path/to/similar/file.ext}` — {What pattern to follow}
```

## Rules

- MUST scan the actual codebase — don't guess file paths or patterns.
- Reference real files in the project, not hypothetical ones.
- Implementation steps should be ordered for minimal merge conflicts.
- Flag if the task requires changes across multiple services.
- Include the complexity estimate (S/M/L/XL) — helps sprint planning.
