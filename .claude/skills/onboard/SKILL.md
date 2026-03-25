---
name: onboard
description: Guided project onboarding — scans the project, generates documentation, creates initial tasks, and sets up the project stage. Use when the user says "onboard", "set up project", "initialize project", or "/onboard".
user-invocable: true
allowed-tools: mcp__vaultops__get_context, mcp__vaultops__generate_docs_prompt, mcp__vaultops__create_task, mcp__vaultops__log_step, mcp__vaultops__write_plan, Read, Glob, Grep, Write
---

# /onboard — Project Onboarding

Guided onboarding flow that turns a bare project into a fully documented VaultOps project.

## Prerequisites

The project must already have `vault add` run (MCP server configured, vault structure created).

## Workflow

### Step 1: Project Discovery
1. Scan the project to understand what it is:
   - Read `README.md`, `package.json`, `go.mod`, `Cargo.toml`, or equivalent
   - Use `Glob` to understand directory structure
   - Identify: language/framework, entry points, key patterns

### Step 2: Generate Documentation
1. Call `generate_docs_prompt` to get vault section status.
2. For each MISSING or EMPTY section, read relevant source files and generate documentation:
   - **00-Overview/System Architecture.md** — tech stack, high-level architecture, key services
   - **01-Requirements/Product Goals.md** — what the project does, target users
   - **04-Development/Codebase Map.md** — directory structure, entry points, key patterns
   - **06-Operations/Runbook.md** — how to start, test, deploy, monitor
3. Write each doc file to the vault using `Write` tool.
4. Call `log_step` for each generated doc.

### Step 3: Set Project Stage
1. Write `Current Stage.md` with initial stage assessment:
   - What stage the project appears to be in (setup, active development, maintenance)
   - Key next steps
2. Write `Context State.md` with current context snapshot.

### Step 4: Create Initial Tasks
1. Based on what's found, create 2-3 initial tasks:
   - If missing tests → "Set up test infrastructure"
   - If missing CI → "Configure CI/CD pipeline"
   - If README is thin → "Improve project documentation"
   - If no .env.example → "Create environment variable documentation"
2. Call `create_task` for each.

### Step 5: Summary
Output:
```
## Project Onboarded: {project_name}

### Generated Documentation
- ✓ System Architecture (00-Overview/)
- ✓ Product Goals (01-Requirements/)
- ✓ Codebase Map (04-Development/)
- ✓ Runbook (06-Operations/)

### Initial Tasks Created
- EXE-001: {title}
- EXE-002: {title}

### Next Steps
- Run `/enrich EXE-001` to get BA/Designer/Dev/QA analysis
- Run `/sprint create` to plan your first sprint
- Run `/today` each morning to see your task dashboard
- Open Obsidian to browse your project brain
```

## Rules

- Keep documentation concise (200-400 words per file).
- Don't generate docs for sections that already have content.
- Create actionable tasks, not vague ones.
- The goal is to give the user a "wow" moment — in 30 seconds they have a documented, tracked project.
