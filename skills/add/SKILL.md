---
name: vault:add
description: Register current project with VaultOps — creates Obsidian vault structure, MCP config, hooks, and skills. Run once per repo. Use when starting work in a new project.
user-invocable: true
allowed-tools: Bash
---

# /vault:add — Register Project with VaultOps

Register the current directory as a VaultOps project.

## Workflow

1. Run `vaultops add` in the current directory.
2. If the command is not found, tell the user to install VaultOps first:
   ```
   curl -fsSL https://raw.githubusercontent.com/Louis-Wu-Sea/vaultops/main/install.sh | bash
   ```
3. On success, display the feature guide below in the chat.
4. On error, show install instructions — do not guess alternatives.

## Rules

- Run from the project root (where `.git` or `package.json` lives).
- If already registered, `vaultops add` is idempotent — safe to re-run.

---

## After Success — Show This Guide

Once `vaultops add` completes, display the following in the chat:

---

## ✓ VaultOps is ready for this project

Your project brain is live. Here's everything you can do:

---

### ⚡ Start here

Run `/vault:docs` — AI scans your codebase and writes full documentation to Obsidian:
architecture overview, API reference, runbook, decisions log, and codebase map.

---

### Daily workflow

| Command | What it does |
|---------|-------------|
| `/vault:today` | Daily task dashboard — scheduled, overdue, active |
| `/vault:task` | Create or update a task (auto EXE-### ID) |
| `/vault:plan` | Write a work plan for a feature or sprint |
| `/vault:kanban` | Visual board grouped by status |
| `/vault:context` | Full project context — stage, tasks, recent journal |

**Example:** "Create a task for the login page redesign"
→ Claude runs `/vault:task`, creates EXE-042 with title, priority, and links it to the sprint.

---

### AI-powered analysis

Run `/vault:enrich EXE-042` to get the full role chain on any task:

| Role | Output |
|------|--------|
| `/vault:ba` | User stories, acceptance criteria, business rules |
| `/vault:designer` | UX flows, component inventory, interaction patterns |
| `/vault:sysanalyst` | Tech spec, data models, API contracts |
| `/vault:dev` | Implementation plan, files to modify, complexity estimate |
| `/vault:qa` | Test plan, test cases, edge cases, regression checklist |

**Example:** "Enrich the checkout task with BA and QA analysis"
→ Claude runs `/vault:enrich EXE-055` — produces structured analysis in Obsidian.

---

### Sprint planning

| Command | What it does |
|---------|-------------|
| `/vault:sprint` | Create sprint, assign tasks, view burndown |

**Example:** "Start sprint 3 with the 5 highest-priority tasks"
→ Claude runs `/vault:sprint`, creates the sprint file, assigns tasks, shows burndown.

---

### CLI commands

```bash
vaultops open       # Open Obsidian vault
vaultops status     # Show registered projects
vaultops update     # Update to latest version
vaultops dashboard  # TUI dashboard in terminal
```

---

### View your vault

```bash
vaultops open
```

Opens Obsidian with your project vault — all docs, tasks, and role outputs visible as a knowledge graph.
