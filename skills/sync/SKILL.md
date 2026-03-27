---
name: vault-sync
description: Autonomous git sync for vault — setup, push, status, schedule management
trigger: /vault:sync
---

# vault:sync — Autonomous Git Sync

You are the vault sync assistant. When this skill is triggered, follow the workflow below
**without asking the user to open a terminal**. All commands run via the Bash tool.

---

## Workflow

### Step 1 — detect intent from the user's words

| User says | Action |
|-----------|--------|
| `/vault:sync` or "sync status" | run `vaultops sync status` → show result |
| `/vault:sync now` or "синкани", "sync it", "push vault" | run `vaultops sync now` |
| `/vault:sync pull` or "pull from remote", "подтяни", "bring local up to date" | run `vaultops sync pull` |
| `/vault:sync setup` or "настрой синк", "connect git", "setup sync" | → see Setup flow below |
| `/vault:sync log` | run `vaultops sync log` |
| `/vault:sync schedule install` | run `vaultops sync schedule install` |
| `/vault:sync schedule uninstall` | run `vaultops sync schedule uninstall` |

---

## Setup Flow (non-interactive — runs entirely in Claude Code)

**Never open a terminal wizard.** Always use `--mode` / `--schedule` / `--remote` flags.

### 1. Check current state

```bash
vaultops sync status
```

### 2. If sync is already configured → skip setup, show status

### 3. If not configured — ask the user TWO questions max:

> **Question 1:** Do you use this vault alone (Personal) or with a team?
> → `personal` or `team`

> **Question 2:** When should it sync?
> → `session` (at end of each Claude session) | `hourly` | `daily` | `manual`

Then run setup with flags (no TTY wizard):

```bash
# Personal + session sync (most common)
vaultops sync setup --mode personal --schedule session

# Personal + hourly background sync
vaultops sync setup --mode personal --schedule hourly

# Team + hourly (installs scheduler automatically)
vaultops sync setup --mode team --schedule hourly

# With explicit remote URL
vaultops sync setup --mode personal --schedule session --remote git@github.com:user/vault.git
```

### 4. If remote URL is needed but not set — ask once:

> "What's your git remote URL? (e.g. `git@github.com:user/vault.git`)"

Then pass it as `--remote <url>`.

### 5. If schedule is `hourly` or `daily` — install the OS scheduler:

```bash
vaultops sync schedule install
```

### 6. Confirm success:

```bash
vaultops sync status
```

---

## Initial Pull (first-time hydration from remote)

When the user wants to bring their local vault in sync with what's on the git server:

```bash
# Vault path is resolved automatically from project config
vaultops sync pull

# If remote not yet configured:
vaultops sync pull --remote git@github.com:user/vault.git
```

This handles all three cases:
- **Directory doesn't exist** → `git clone` from remote
- **Directory exists, no `.git`** → init + commit local files + merge remote
- **Already a git repo** → `git pull --rebase`

---

## Modes

**Personal** — solo use, single machine
- Auto-resolves conflicts (keeps local version)
- Session-end or hourly sync

**Team** — shared vault, multiple contributors
- `.gitattributes` with `merge=union` for journals/logs
- Conflict notification (`08-Execution/Conflict Report.md`)
- Hourly sync recommended
- Commit messages include `[name@host]`

---

## MCP Tool

`get_sync_status` — check sync state programmatically (last sync, pending, conflicts, mode, schedule).

---

## Autonomous Behavior

- `schedule=session` → **Stop hook** auto-syncs at end of every Claude Code session
- `schedule=hourly` / `schedule=daily` → **launchd** (macOS) or **cron** (Linux) runs in background
