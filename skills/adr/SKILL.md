---
name: vault:adr
description: Create an Architecture Decision Record (ADR) in the vault. Use when the user says "ADR", "architecture decision", "document decision", "record decision", or "/vault:adr".
argument-hint: <decision title>
user-invocable: true
allowed-tools: mcp__vaultops__generate_docs_prompt, mcp__vaultops__log_step, Read, Write, Glob
---

# /vault:adr — Architecture Decision Record

Create a new ADR following the standard format (Title, Status, Context, Decision, Consequences).

## Workflow

1. Parse `$ARGUMENTS` as the decision title. If empty, ask for one.
2. Call `generate_docs_prompt` to get the vault paths.
3. Find existing ADRs in `section_paths["02-Research"]` using `Glob` for files matching `ADR-*.md`.
4. Determine the next ADR number (auto-increment from highest existing).
5. Generate the ADR file name: `ADR-{NNN}-{slug}.md` where slug is the title in kebab-case.
6. Ask the user for:
   - **Context**: What is the issue?
   - **Decision**: What are we doing about it?
   - **Consequences**: What are the trade-offs?
7. Write the ADR file to `section_paths["02-Research"]`.
8. Update `02-Research/Technical Decisions.md` — add a row to the Decision Index table.
9. Call `log_step` to record the ADR creation.
10. Output: `✓ Created ADR-{NNN}: {title}`

## ADR Template

```markdown
---
tags: [adr, decision, architecture]
created: {YYYY-MM-DD}
status: proposed
adr_number: {NNN}
aliases: [ADR-{NNN}]
---

# ADR-{NNN}: {Decision Title}

**Status:** 🟡 Proposed | **Date:** {YYYY-MM-DD}

---

## Context

{What is the issue that we're seeing that motivates this decision or change?}

---

## Decision

{What is the change that we're proposing and/or doing?}

---

## Consequences

> [!SUCCESS] Benefits
> - {positive consequence}

> [!WARNING] Trade-offs
> - {negative consequence or risk accepted}

> [!NOTE]- Alternatives Considered
> - **{Alternative A}**: {why rejected}
> - **{Alternative B}**: {why rejected}

---

## Related

- [[System Architecture]]
- [[{related ADR if any}]]
```

## ADR Status Lifecycle

| Status | Meaning | Emoji |
|--------|---------|-------|
| Proposed | Under discussion, not yet accepted | 🟡 |
| Accepted | Decision made, implementing | ✅ |
| Deprecated | No longer applies, replaced | ⚠️ |
| Superseded | Replaced by another ADR | 🔄 |

## Rules

- Keep context section factual — describe the forces at play, not the solution.
- Decision section should be declarative — "We will use X" not "We could use X".
- Always document alternatives considered — shows the decision wasn't arbitrary.
- Link ADRs to the System Architecture doc and related ADRs via wiki-links.
- Update status from Proposed → Accepted once the team agrees.
