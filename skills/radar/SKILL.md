---
name: vault:radar
description: Architecture Radar — detect coupling patterns, hotspots, and drift. Shows files that always change together and suggests ADRs. Use when the user says "architecture", "coupling", "radar", "tech debt", or "/vault:radar".
argument-hint:
user-invocable: true
allowed-tools: mcp__vaultops__get_arch_radar, mcp__vaultops__get_context
---

# /vault:radar — Architecture Radar

Detect architecture patterns and anti-patterns from task history.

## Workflow

1. Call `get_arch_radar` to analyze file change patterns across tasks.
2. Present findings:
   - **Hotspots**: most-changed files (possible complexity magnets)
   - **Coupling**: file pairs that always change together (separation of concerns issue)
   - **Insights**: cross-module coupling, change frequency trends
   - **ADR suggestions**: when patterns suggest architecture decisions needed
3. If a Mermaid coupling diagram was generated, include it.
4. Suggest next steps: "Consider an ADR for decoupling X from Y."

## When to use

- Sprint retrospective — "what's causing churn?"
- Before major refactoring — "where are the coupling hotspots?"
- Architecture review — "is our module boundary clean?"
- Tech debt assessment — "what areas need attention?"
