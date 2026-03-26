---
name: vault:enrich
description: Orchestrate role-based task enrichment (BA → Designer → SystemAnalyst → Developer → QA). Generates structured analysis for each role using parallel sub-agents where possible. Use when the user says "enrich task", "analyze task", "fill in roles", or "/vault:enrich EXE-###".
argument-hint: <task_id>
user-invocable: true
allowed-tools: mcp__vaultops__get_task, mcp__vaultops__get_role_output, mcp__vaultops__write_role_output, mcp__vaultops__get_context, mcp__vaultops__log_step, Read, Agent
---

# /vault:enrich — Role-Based Task Enrichment Orchestrator

Enriches a task with structured analysis from 5 roles using a smart parallel pipeline:
**BA → (Designer ║ SysAnalyst) → Developer → QA**

## Step 1 — Setup

1. Parse `$ARGUMENTS` to extract the task ID (e.g., `EXE-001`). If empty, ask for a task ID.
2. Call `get_task` to get current state and completed roles.
3. Call `get_context` to get the project path.
4. Read per-role model config from `.vaultops/config.env` in the project directory.
   Parse these keys (default to `inherit` if missing):
   ```
   ENRICH_MODEL_BA
   ENRICH_MODEL_DESIGNER
   ENRICH_MODEL_SYSANALYST
   ENRICH_MODEL_DEVELOPER
   ENRICH_MODEL_QA
   ```
   Model values: `inherit` (use current user's model), `haiku`, `sonnet`, `opus`.

## Step 2 — Display Config Table

Before running any roles, display this table so the user sees exactly what will run:

```
┌─ Конфигурация ролей — {task_id}: {task_title} ──────────────────┐
│                                                                  │
│  Шаг  Роль          Модель         Задача                        │
│  ─────────────────────────────────────────────────────────────  │
│  1    BA            {model}        Истории, MoSCoW, impact       │
│  2    Designer      {model}        UX flows, компоненты          │
│  2    SysAnalyst    {model}        ER диаграммы, API             │ ← параллельно
│  3    Developer     {model}        Код план, зависимости         │
│  4    QA            {model}        BDD, матрица тестов           │
│                                                                  │
│  ◆ текущая модель пользователя   ◇ настроено пользователем       │
│                                                                  │
│  Настройка: vault config set enrich.ba haiku                     │
│  (haiku быстрее и дешевле, но даёт менее детальный output)       │
└──────────────────────────────────────────────────────────────────┘
```

Show `◆ {model_name}*` for `inherit`, show `◇ {model_name}` for explicit values.

## Step 3 — Smart Parallel Pipeline

**Important gate rules:**
- Roles already marked `complete` in the task — skip them.
- BA must always run first (provides business context for all other roles).
- QA must always run last (validates everything).
- Designer and SysAnalyst can run in parallel after BA completes.
- Developer runs after Designer and SysAnalyst both complete.

### Step 3.1 — BA (if not already complete)

Launch a sub-agent for BA. Pass `model` only if config value is NOT `inherit`:

```
Agent(
  description: "BA enrichment for {task_id}",
  model: {ba_model_if_not_inherit},   ← omit this parameter if value is "inherit"
  prompt: """
    You are performing Business Analyst enrichment for task {task_id}: {task_title}.

    Task description:
    {task_description}

    Acceptance criteria:
    {acceptance_criteria}

    Generate BA output following this structure:
    - User stories (As a... I want... So that...)
    - Acceptance criteria in Given/When/Then format
    - Business rules
    - Scope boundaries (in/out)
    - Stakeholders affected

    Then call mcp__vaultops__write_role_output with:
      - task_id: {task_id}
      - role: "BA"
      - content: {the generated markdown content}

    After writing, report: "✓ BA complete"
  """
)
```

Wait for this sub-agent to complete before proceeding.
Report progress: `⟳ Step 1/4 — BA complete`

### Step 3.2 — Designer ║ SysAnalyst in parallel (if not already complete)

Read BA output via `get_role_output(task_id, "BA")`.

Then launch BOTH sub-agents in a SINGLE message (parallel execution):

**Designer sub-agent:**
```
Agent(
  description: "Designer enrichment for {task_id}",
  model: {designer_model_if_not_inherit},
  prompt: """
    You are performing Designer enrichment for task {task_id}: {task_title}.

    Task description: {task_description}

    BA output:
    {ba_output}

    Generate Designer output:
    - UX flow (step-by-step user journey)
    - Component inventory (UI elements needed)
    - Interaction patterns (hover, click, transitions)
    - Accessibility notes (ARIA, contrast, keyboard nav)

    Call mcp__vaultops__write_role_output:
      - task_id: {task_id}
      - role: "Designer"
      - content: {generated markdown}

    Report: "✓ Designer complete"
  """
)
```

**SysAnalyst sub-agent (launched at the same time):**
```
Agent(
  description: "SysAnalyst enrichment for {task_id}",
  model: {sysanalyst_model_if_not_inherit},
  prompt: """
    You are performing System Analyst enrichment for task {task_id}: {task_title}.

    Task description: {task_description}

    BA output:
    {ba_output}

    Generate SysAnalyst output:
    - Technical specification
    - Data model changes (entities, fields, relationships)
    - API contracts (endpoints, request/response schemas)
    - Integration points (external services, internal modules)
    - Performance considerations

    Call mcp__vaultops__write_role_output:
      - task_id: {task_id}
      - role: "SystemAnalyst"
      - content: {generated markdown}

    Report: "✓ SysAnalyst complete"
  """
)
```

Wait for BOTH to complete.
Report progress: `⟳ Step 2/4 — Designer + SysAnalyst complete (ran in parallel)`

### Step 3.3 — Developer (if not already complete)

Read outputs: `get_role_output(task_id, "BA")`, `get_role_output(task_id, "Designer")`, `get_role_output(task_id, "SystemAnalyst")`.

```
Agent(
  description: "Developer enrichment for {task_id}",
  model: {developer_model_if_not_inherit},
  prompt: """
    You are performing Developer enrichment for task {task_id}: {task_title}.

    Task: {task_description}

    BA output: {ba_output}
    Designer output: {designer_output}
    SysAnalyst output: {sysanalyst_output}

    Generate Developer output:
    - Implementation plan (ordered steps)
    - Files to create/modify (with paths)
    - Architecture decisions (patterns, libraries)
    - Risks and unknowns
    - Estimated complexity (S/M/L)

    Call mcp__vaultops__write_role_output:
      - task_id: {task_id}
      - role: "Developer"
      - content: {generated markdown}

    Report: "✓ Developer complete"
  """
)
```

Wait for completion.
Report: `⟳ Step 3/4 — Developer complete`

### Step 3.4 — QA (if not already complete)

Read all outputs: BA, Designer, SystemAnalyst, Developer.

```
Agent(
  description: "QA enrichment for {task_id}",
  model: {qa_model_if_not_inherit},
  prompt: """
    You are performing QA enrichment for task {task_id}: {task_title}.

    Task: {task_description}

    BA output: {ba_output}
    Designer output: {designer_output}
    SysAnalyst output: {sysanalyst_output}
    Developer output: {developer_output}

    Generate QA output:
    - Test strategy
    - Test cases for each acceptance criterion (unit, integration, E2E)
    - Edge cases
    - Regression risks
    - Environment requirements

    Call mcp__vaultops__write_role_output:
      - task_id: {task_id}
      - role: "QA"
      - content: {generated markdown}

    Report: "✓ QA complete"
  """
)
```

Wait for completion.
Report: `⟳ Step 4/4 — QA complete`

## Step 4 — Finalize

Call `log_step` to record completion.

Output final summary:

```
## Enrichment Summary — {task_id}: {task_title}

| Шаг | Роль         | Статус     | Модель      |
|-----|--------------|------------|-------------|
| 1   | BA           | ✓ Complete | {model}     |
| 2   | Designer     | ✓ Complete | {model}     |
| 2   | SysAnalyst   | ✓ Complete | {model}     |
| 3   | Developer    | ✓ Complete | {model}     |
| 4   | QA           | ✓ Complete | {model}     |

Артефакты сохранены в: 08-Execution/Role Outputs/{task_id}/
```

## Skipping Already-Complete Roles

If a role is already `complete` in the task state, skip its sub-agent entirely.
Still include it in the summary table with `✓ Already complete (skipped)`.
User can re-run a specific role via: `/vault:ba {task_id}`, `/vault:designer {task_id}`, etc.
