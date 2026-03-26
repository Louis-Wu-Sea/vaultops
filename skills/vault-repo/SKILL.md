---
name: vault:repo
description: Initialize or sync a standalone documentation repo (no code project required). Use for PMs, designers, and anyone who needs task management without a codebase. Use when the user says "doc repo", "standalone repo", "docs without code", or "/vault:repo".
argument-hint: init [path] --remote <git-url> | sync | status
user-invocable: true
allowed-tools: Bash
---

# /vault:repo — Standalone Doc Repo

Create and manage a git-backed Obsidian vault without a code project. Designed for designers, PMs, writers, and anyone who needs VaultOps task management for documentation.

## Commands

### Initialize a new doc repo
```bash
vaultops repo init [path] --remote <git-url> --autocommit <granular|session|off>
```
- `path` — directory for the vault (default: current directory)
- `--remote` — git remote URL to link (optional)
- `--autocommit` — commit strategy: `granular` (after each MCP action), `session` (batch on session end), `off` (default: session)

### Sync with remote
```bash
vaultops repo sync
```
Commits pending changes, pulls with rebase, pushes to origin.

### List registered doc repos
```bash
vaultops repo status
```

## What it creates

```
<path>/
  .git/                    # Git repository
  .gitignore               # Ignores .vaultops/
  .vaultops/config.env     # Doc-repo config (VAULTOPS_DOC_REPO=true)
  00-Overview/ ... 07-References/   # Documentation sections
  08-Execution/            # Task management
    Task Board.md
    Tasks/
    Role Outputs/
    Work Plans.md
    Execution Journal.md
    Current Stage.md
    Context State.md
```

## After init

All VaultOps tools work — `/task`, `/plan`, `/kanban`, `/docs`, `/enrich`, etc. Tasks auto-commit when `VAULTOPS_AUTOCOMMIT=granular` is set.

## Workflow

1. Parse the user's arguments.
2. Run the appropriate `vaultops repo` command via Bash.
3. On error, check if VaultOps CLI is installed and suggest `vaultops update` if needed.
