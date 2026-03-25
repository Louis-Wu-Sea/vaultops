---
name: vault:designer
description: Designer role — generates UX flows, component inventory, interaction patterns, and accessibility notes for a task. Use when the user says "design analysis", "UX flow", "UI components", or "/vault:designer EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__get_project_dna, mcp__vaultops__log_step
---

# /vault:designer — Designer Role

Generate UX/UI design analysis for a task based on BA output. Adapts to project style via Project DNA.

## Workflow

1. Parse `$ARGUMENTS` for task ID. If empty, ask for one.
2. Call `get_project_dna` to understand the project's design patterns (responsive, a11y, dark mode, component library). Adapt output to match.
3. Call `get_task` to read task details and existing role outputs.
4. Call `get_role_output` with `role=BA` to get the BA analysis as input context.
4. If BA output doesn't exist, warn: `⚠️ BA analysis not found. Running without BA context — results may be less accurate.`
5. Generate Designer output following the template below.
6. Call `write_role_output` with `role=Designer` and the generated content.
7. Call `log_step` to record completion.
8. Output: `✓ Designer analysis complete for {task_id}. Next role: SystemAnalyst.`

## Output Template

```markdown
# Design Analysis — {task_id}: {title}

## User Flow

```mermaid
stateDiagram-v2
    [*] --> Entry
    Entry --> {Step1}: {user action}
    {Step1} --> {Step2}: {system response}
    {Step2} --> Success: completed
    {Step2} --> Error: failed

    state Error {
        [*] --> ShowError
        ShowError --> RetryPrompt
        RetryPrompt --> {Step1}: retry
    }

    Success --> [*]
```

### Flow Steps

| Step | User Action | System Response | Next |
|------|------------|-----------------|------|
| Entry | {how user arrives} | {initial UI state} | Step 1 |
| Step 1 | {action} | {response} | Step 2 |
| ... | ... | ... | ... |

## Component Inventory

| Component | Type | Purpose | Existing? |
|-----------|------|---------|-----------|
| {Name} | {Button/Form/Modal/List/...} | {What it does} | {Yes — `path`, or No — create} |

## Component State Matrix

| Component | Default | Hover | Active | Disabled | Loading | Error |
|-----------|---------|-------|--------|----------|---------|-------|
| {Name} | {description} | {description} | {description} | {when} | {behavior} | {behavior} |

## Interaction Patterns

- **{Pattern}**: {Description of hover/click/transition/animation behavior}

## Responsive Breakpoints

| Breakpoint | Width | Layout Changes |
|------------|-------|---------------|
| 📱 Mobile | < 640px | {stacked layout, hamburger menu, etc.} |
| 📱 Tablet | 640–1024px | {sidebar collapses, 2-column grid, etc.} |
| 🖥️ Desktop | > 1024px | {full sidebar, 3-column grid, etc.} |

## Accessibility — WCAG 2.1 AA

### Keyboard Navigation
- [ ] All interactive elements focusable via Tab
- [ ] Logical tab order matches visual order
- [ ] Enter/Space activates buttons and links
- [ ] Escape closes modals/dropdowns
- [ ] Custom keyboard shortcuts documented

### Screen Reader
- [ ] Meaningful ARIA labels on all interactive elements
- [ ] ARIA roles for custom components
- [ ] Live regions (`aria-live`) for dynamic content
- [ ] Form inputs have associated labels

### Visual
- [ ] Color contrast ratio ≥ 4.5:1 (text) / 3:1 (large text)
- [ ] Focus indicators visible on all interactive elements
- [ ] No information conveyed by color alone
- [ ] `prefers-reduced-motion` respected for animations

## States

| State | Description | UI Treatment |
|-------|-------------|-------------|
| Empty | {No data yet} | {Empty state message/illustration} |
| Loading | {Fetching data} | {Skeleton/spinner} |
| Error | {Failed to load} | {Error message + retry button} |
| Success | {Normal with data} | {Default view} |
| Partial | {Some data loaded} | {Progressive reveal} |
```

## Rules

- Reference BA user stories when describing flows.
- State diagrams MUST use `stateDiagram-v2` Mermaid syntax — no linear text lists.
- Flag which components already exist in the codebase vs need to be created.
- Keep interaction descriptions concrete, not abstract.
- Always include empty, loading, error, and success states.
- WCAG 2.1 AA checklist must be included — accessibility is not optional.
- Responsive breakpoints must cover mobile, tablet, and desktop.
