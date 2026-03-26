---
name: vault-sync
description: Autonomous git sync for vault — setup, push, status, schedule management
trigger: /vault:sync
---

# vault:sync — Autonomous Git Sync

Manage autonomous git synchronization for your Obsidian vault.

## Commands

| Command | What it does |
|---------|-------------|
| `/vault:sync` | Show sync status (last sync, pending changes, conflicts) |
| `/vault:sync setup` | Interactive wizard — connect git remote, choose Personal or Team mode, configure schedule |
| `/vault:sync now` | Sync immediately (commit + pull --rebase + push) |
| `/vault:sync log` | Show recent sync history from Sync Log.md |
| `/vault:sync schedule install` | Install OS scheduler (launchd on macOS, cron on Linux) |
| `/vault:sync schedule uninstall` | Remove OS scheduler |

## Modes

**Personal** — solo use, single machine  
- Auto-resolves conflicts (keeps local version)  
- Defaults to session-end sync  

**Team** — shared vault with multiple contributors  
- `.gitattributes` with `merge=union` for journals/logs  
- Conflict notification (writes `08-Execution/Conflict Report.md`)  
- Defaults to hourly sync  
- Includes `[name@host]` in commit messages  

## Setup Flow

```
vaultops sync setup
```

The wizard will:
1. Detect or prompt for git remote URL
2. Ask: Personal or Team mode
3. Choose schedule (session / hourly / daily / manual)
4. Auto-configure conflict strategy
5. Write `.gitattributes` (Team mode only)
6. Test remote connectivity
7. Install OS scheduler if hourly/daily

## CLI Quick Reference

```bash
# One-time setup
vaultops sync setup

# Manual sync
vaultops sync now

# Status check
vaultops sync status

# Install/remove background scheduler
vaultops sync schedule install
vaultops sync schedule uninstall
```

## Autonomous Behavior

When `schedule=session`, the **Stop hook** automatically syncs at the end of every Claude Code session. The session summary shows: `Synced → github.com/user/repo`

When `schedule=hourly` or `schedule=daily`, a **launchd plist** (macOS) or **cron entry** (Linux) runs `vaultops sync now` in the background without needing Claude Code open.

## MCP Tool

`get_sync_status` — returns last sync time, pending changes, conflicts, mode, and schedule.
