---
name: vault:status
description: Show all projects registered with VaultOps — paths, vault locations, and registration status. Use to check what's set up or troubleshoot missing config.
user-invocable: true
allowed-tools: Bash
---

# /vault:status — VaultOps Project Status

Show all registered VaultOps projects.

## Workflow

1. Run: `vaultops status`
2. Display the output — list of registered projects with their vault paths.
3. If no projects are registered, suggest: `cd /path/to/repo && vaultops add`

## Rules

- If command not found, show install instructions.
- If user asks about a specific project, run: `vaultops status /path/to/project`
