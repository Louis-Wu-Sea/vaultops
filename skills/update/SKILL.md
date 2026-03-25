---
name: vault:update
description: Update VaultOps to the latest version — downloads new runtime, MCP server, and skills. Safe to run anytime.
user-invocable: true
allowed-tools: Bash
---

# /vault:update — Update VaultOps

Download and install the latest VaultOps release.

## Workflow

1. Run: `vaultops update`
2. The command verifies the download checksum before installing.
3. Report what was updated (scripts, MCP server, skills count).

## Rules

- License, vault content, project registry, and settings are never modified by update.
- If update fails with a checksum error, warn the user — do not retry automatically.
- If command not found, show install instructions.
