---
name: vault:learn
description: Run learning analysis on execution history. Shows what VaultOps has learned about your project — intent accuracy, cycle times, priority calibration, and recurring patterns. Use when curious about project metrics or to improve VaultOps accuracy.
user-invocable: true
allowed-tools: mcp__vaultops__get_learning_status, mcp__vaultops__learn_from_history, mcp__vaultops__get_insights, mcp__vaultops__log_step
---

# /vault:learn — Self-Learning Analysis

Analyze execution history and surface learned patterns about this project.

## Workflow

1. Detect the current project path from the working directory.
2. Call `get_learning_status` to check current learning state (data points, confidence, staleness).
3. If last analysis is stale (>24h old or never run) AND there are enough events (3+), call `learn_from_history` with focus "all".
4. Call `get_insights` to surface the top actionable patterns.
5. Present findings in a structured report.
6. If high-confidence patterns exist, suggest memory promotion entries.
7. Call `log_step` with message "Ran learning analysis" to record in journal.

## Output Format

```
## VaultOps Learning Report — {project}

### Status
- Data points: {N} events across {N} sessions
- Confidence: {low|medium|high}
- Last analysis: {timestamp}

### Intent Classification
- Accuracy: {N}% ({correct}/{total})
- Match layers: stem {N}%, transliterate {N}%, fuzzy {N}%, implicit {N}%
- Corrections: {count} ({types})

### Cycle Time
| Work Type | Avg | Median | Count |
|-----------|-----|--------|-------|
| bugfix | 1.2h | 0.8h | 15 |
| new_feature | 4.5h | 3.2h | 20 |

### Priority Calibration
- Accuracy: {N}%
- Correction pattern: {from}->{to} ({count} times)

### Auto-Completion
- Accuracy: {N}%
- Reopened: {count}

### Insights
1. {insight with confidence}
2. {insight with confidence}

### Suggested Memory Entries
(high-confidence patterns formatted for /si:remember)
- {pattern description}
```

## Rules

- If fewer than 3 events exist, say "Not enough history yet — VaultOps is collecting data automatically as you work." and skip analysis.
- Always show confidence level — users should know when insights are preliminary.
- Never auto-write to Claude's MEMORY.md — always present suggestions and let the user decide.
- Keep output actionable — every insight should have a "so what" implication.
- If `/si:remember` is available, suggest it for high-confidence patterns.
- Group related insights together (e.g., all priority-related insights in one section).
