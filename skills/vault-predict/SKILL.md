---
name: vault:predict
description: Predictive Brain — forecast cycle time, risk, and priority for a task based on historical patterns. Use when the user says "predict", "estimate", "how long", "risk", or "/vault:predict EXE-###".
argument-hint: <EXE-###> or <work_type>
user-invocable: true
allowed-tools: mcp__vaultops__get_predictions, mcp__vaultops__get_task, mcp__vaultops__get_learning_status
---

# /vault:predict — Predictive Brain

Get AI-powered predictions for a task — cycle time estimate, risk assessment, and calibrated priority.

## Workflow

1. Parse `$ARGUMENTS`:
   - If task ID (e.g., `EXE-001`) — predict for that specific task
   - If work type (e.g., `bugfix`, `refactor`) — predict for that type generally
   - If empty — predict for the currently active task
2. Call `get_predictions` with the parsed parameters.
3. Present the forecast with confidence indicators:
   - **Cycle Time**: predicted hours with range (IQR) and confidence level
   - **Risk**: low/medium/high with specific reasons
   - **Priority**: suggested priority with reasoning from historical patterns
4. If confidence is low, suggest: "Run more tasks to improve predictions."

## Output Format

```
Predictive Brain  ·  Forecast

  CYCLE TIME
     Predicted: 2.3h  (1.5–3.8h range)
     Confidence: ███░ medium  (7 samples)
     Based on: same type (bugfix)

  RISK: MEDIUM
     · 4 files to change — moderate scope
     · Architecture file(s): middleware.go
     → Add verify: checks to this task

  PRIORITY: P1
     bugfix tasks are usually P1 (78% of 9 tasks)
```

## When predictions are unreliable

If sample size < 3, show:
```
Not enough data yet. Complete a few more tasks and predictions will improve.
Current data: N events collected.
```

## Rules

- Always show confidence levels — never present predictions as facts
- Include sample size so the user knows how much data backs the prediction
- Suggest verify checks when risk is medium or high
- Don't show predictions for questions or non-work intents
