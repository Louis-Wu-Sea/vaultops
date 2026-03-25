---
name: vault:dev
description: Developer role — generates implementation plan, files to modify, architecture decisions, and complexity estimate for a task. Use when the user says "implementation plan", "dev plan", "how to implement", or "/vault:dev EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__get_project_dna, mcp__vaultops__log_step, Glob, Grep, Read
---

# /vault:dev — Developer Role

Generate implementation plan for a task based on all previous role outputs AND actual codebase analysis. Adapts to project style via Project DNA.

## Workflow

1. Parse `$ARGUMENTS` for task ID. If empty, ask for one.
2. Call `get_project_dna` to read the project's tech stack, testing style, and patterns. **Adapt your output** to match the detected stack (e.g., Go test patterns for Go projects, Playwright for e2e).
3. Call `get_task` to read task details and existing role outputs.
4. Call `get_role_output` for `BA`, `Designer`, and `SystemAnalyst` roles.
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

## Module Dependency Graph

```mermaid
graph LR
    {ModuleA}[{Module A}] --> {ModuleB}[{Module B}]
    {ModuleA} --> {ModuleC}[{Module C}]
    {ModuleB} --> {ModuleD}[{Module D}]

    style {ModuleA} fill:#ef4444,color:#fff
    style {ModuleB} fill:#f59e0b,color:#fff
    style {ModuleC} fill:#6b7280,color:#fff
    style {ModuleD} fill:#6b7280,color:#fff

    classDef changed fill:#ef4444,color:#fff
    classDef affected fill:#f59e0b,color:#fff
    classDef stable fill:#6b7280,color:#fff
```

> 🔴 Changed directly · 🟡 Potentially affected · ⚪ Stable

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

## File Change Impact Analysis

| Changed File | May Break | Why | Verify With |
|-------------|-----------|-----|-------------|
| `{path}` | `{dependent file}` | {reason} | `{test command}` |

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

## PR Template

> **Title:** `feat({scope}): {short description}`
>
> **Description:**
> {What this PR does and why}
>
> **Testing:**
> - [ ] Unit tests pass
> - [ ] Integration tests pass
> - [ ] Manual verification of {key scenario}
>
> **Screenshots:** {if UI changes}
```

## Rules

- MUST scan the actual codebase — don't guess file paths or patterns.
- Reference real files in the project, not hypothetical ones.
- Implementation steps should be ordered for minimal merge conflicts.
- Module dependency graph MUST use Mermaid and color-code changed vs affected vs stable modules.
- File Change Impact Analysis must identify files that might break due to this change.
- Flag if the task requires changes across multiple services.
- Include the complexity estimate (S/M/L/XL) — helps sprint planning.
- PR template section helps standardize code review process.
