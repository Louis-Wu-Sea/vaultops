# VaultOps

**Claude Code plugin for Obsidian-based task management**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow.svg)](https://buymeacoffee.com/vaultops)

VaultOps bridges Claude Code and Obsidian — giving your AI assistant persistent project memory. Tasks, sprints, meeting notes, architecture decisions, and role-based analysis are stored as local markdown files with YAML frontmatter, viewable in Obsidian's graph and Dataview.

## Features

- **43 MCP tools** — task CRUD, sprint planning, role enrichment, meeting notes, cross-project search, predictive analytics
- **27 slash commands** — `/vault:today`, `/vault:task`, `/vault:sprint`, `/vault:enrich`, `/vault:meeting`, and more
- **TUI dashboard** — multi-project aggregate view in your terminal
- **Role enrichment pipeline** — BA, Designer, System Analyst, Developer, QA analysis per task
- **Task-as-Code** — verify contracts in task frontmatter (`file_exists`, `grep_content`, `test_pattern`)
- **Predictive Brain** — cycle time forecasting and risk assessment from historical patterns
- **Sprint management** — burndown charts, velocity tracking, DoD/DoR
- **Meeting notes** — action item dispatch to project task boards, follow-up scheduling
- **Cross-project intelligence** — search and link tasks across all registered projects
- **Architecture radar** — coupling detection, hotspot analysis, ADR suggestions
- **Zero dependencies** — Python stdlib (MCP server), Node.js stdlib (CLI)
- **Fully offline** — all data in local Obsidian markdown files, no network calls

## Quick Start

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/Louis-Wu-Sea/vaultops/main/install.sh | bash

# Register your project
cd /path/to/your/repo
vaultops add

# Open Claude Code and try
/vault:today
```

### Manual Install

```bash
git clone https://github.com/Louis-Wu-Sea/vaultops.git
cd vaultops
./install.sh
```

## How It Works

```
Claude Code  <->  MCP Server (Python)  <->  Obsidian Vault (Markdown + YAML)
     |                                           |
  27 Skills                                  Graph View
  (slash cmds)                               Dataview
                                             Canvas
```

1. **You work in Claude Code** — use slash commands like `/vault:task` or `/vault:sprint`
2. **MCP server reads/writes** markdown files with YAML frontmatter in your Obsidian vault
3. **Obsidian renders** everything — graph view shows task relationships, Dataview queries your data, canvas boards visualize sprints

## Slash Commands

| Command | Description |
|---------|-------------|
| `/vault:today` | Daily task dashboard — scheduled, overdue, active |
| `/vault:task` | Create/update tasks with EXE-### IDs |
| `/vault:plan` | Write work plans |
| `/vault:kanban` | Kanban board view |
| `/vault:sprint` | Sprint management with velocity trends |
| `/vault:enrich` | Full role enrichment: BA -> Designer -> SysAnalyst -> Dev -> QA |
| `/vault:meeting` | Meeting notes with action item dispatch |
| `/vault:docs` | Generate project documentation |
| `/vault:retro` | Sprint retrospective with metrics |
| `/vault:context` | Full project context verification |

See all 27 commands in [CLAUDE.md](CLAUDE.md).

## CLI Commands

```bash
vaultops add [path]       # Register a project
vaultops init [path]      # Set up vault structure
vaultops status           # Show registered projects
vaultops dashboard        # Interactive multi-project TUI
vaultops open [path]      # Open Obsidian vault
vaultops update           # Update to latest version
vaultops config           # Per-project settings
vaultops uninstall        # Clean removal
```

## Vault Structure

```
08-Execution/
  Task Board.md              # Summary table
  Tasks/
    EXE-001.md               # Individual tasks with YAML frontmatter
    EXE-001.1.md             # Sub-tasks
  Role Outputs/
    EXE-001/
      BA.md / Designer.md / SystemAnalyst.md / Developer.md / QA.md
  Sprints/
    Sprint-1.md
  Work Plans.md
  Execution Journal.md
_meetings/
  Notes/MTG-001.md           # Meeting notes with action items
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

Key constraints:
- MCP server: **Python stdlib only** (no pip dependencies)
- CLI: **Node.js stdlib only** (no npm dependencies)
- Data: Obsidian-compatible markdown with YAML frontmatter

## Support

If VaultOps is useful to you, consider supporting development:

- [Buy Me a Coffee](https://buymeacoffee.com/vaultops)
- Star this repo

## License

[MIT](LICENSE)
