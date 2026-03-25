---
name: qa
description: QA role — generates test plan, test cases, edge cases, and regression checklist for a task. Use when the user says "test plan", "test cases", "QA analysis", or "/qa EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__log_step, Glob, Grep, Read
---

# /qa — QA Role

Generate comprehensive test plan for a task based on all previous role outputs.

## Workflow

1. Parse `$ARGUMENTS` for task ID. If empty, ask for one.
2. Call `get_task` to read task details and existing role outputs.
3. Call `get_role_output` for `BA`, `Designer`, `SystemAnalyst`, and `Developer` roles.
4. **Scan the codebase** for existing test patterns using Glob/Grep to understand:
   - Test framework in use (Vitest, Jest, Go testing, Playwright, etc.)
   - Existing test file locations and naming conventions
   - Test utilities and helpers available
5. Generate QA output following the template below.
6. Call `write_role_output` with `role=QA` and the generated content.
7. Call `log_step` to record completion.
8. Output: `✓ QA analysis complete for {task_id}. All roles enriched.`

## Output Template

```markdown
# Test Plan — {task_id}: {title}

## Test Strategy

- **Unit tests**: {What to test at unit level, framework}
- **Integration tests**: {API/service integration points to test}
- **E2E tests**: {User flows to test end-to-end, framework}

## Test Cases

### TC-1: {Test case name} (maps to AC: {acceptance criterion ID})
- **Type**: {Unit | Integration | E2E}
- **Preconditions**: {Setup required}
- **Steps**:
  1. {Action}
  2. {Action}
- **Expected**: {Expected result}
- **Priority**: {P1 | P2 | P3}

### TC-2: {Test case name}
...

## Edge Cases

| # | Scenario | Expected Behavior | Priority |
|---|----------|-------------------|----------|
| 1 | {Edge case description} | {What should happen} | {P1-P3} |

## Negative Tests

| # | Scenario | Expected Error | Status Code |
|---|----------|---------------|-------------|
| 1 | {Invalid input scenario} | {Error message} | {HTTP code if API} |

## Regression Risks

- ⚠️ {Area of code that might break due to this change}
- **How to verify**: {Quick check to confirm no regression}

## Environment Requirements

- {Database state, test fixtures, mock services}
- {Environment variables needed for tests}

## Test File Locations

| Test File | Type | Tests |
|-----------|------|-------|
| `{path/to/test.ext}` | {Unit/Integration/E2E} | {Create | Modify} |

## Acceptance Checklist

- [ ] All acceptance criteria from BA have corresponding test cases
- [ ] Edge cases identified and tested
- [ ] Error handling tested (negative tests)
- [ ] Regression areas verified
- [ ] Accessibility requirements tested (if applicable from Designer)
```

## Rules

- Every BA acceptance criterion MUST have at least one test case.
- Reference actual test framework and patterns from the codebase.
- Include BOTH happy path and error path test cases.
- Prioritize test cases (P1 = must have, P2 = should have, P3 = nice to have).
- Flag if existing tests need modification due to the change.
