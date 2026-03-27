---
name: vault:open
description: Open the Obsidian vault for this project. Use when you want to browse tasks, notes, or documentation in Obsidian.
user-invocable: true
allowed-tools: Bash
---

# /vault:open — Open Obsidian Vault

Open the Obsidian vault for the current project.

## Workflow

1. Run: `vaultops open`
2. Obsidian will open to the project vault.
3. If the command fails, tell the user to open Obsidian manually and add the vault path shown in the error.

## Rules

- Works on macOS, Linux, Windows.
- If Obsidian is not installed, the command will try to open the vault folder instead.
