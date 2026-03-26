# VaultOps

Claude is brilliant. But it forgets everything when you close the tab.

VaultOps gives Claude a notebook.
Every task, decision, and doc gets saved to a local Obsidian vault.
When you open Claude tomorrow — it picks up exactly where you left off.

## Three steps, that's it

```bash
# Step 1 — Install (once, on your machine)
curl -fsSL https://raw.githubusercontent.com/Louis-Wu-Sea/vaultops/main/install.sh | bash

# Step 2 — Open a notebook for your project (once per repo)
cd /path/to/your/repo
vaultops add

# Step 3 — Open Claude Code and start
/vault:today
```

> **Step 2 is the important one.**
>
> `vaultops add` connects Claude to your project's notebook.
> Without it, Claude starts fresh every time — no memory, no tasks, no history.
> Run it once in every project you want Claude to remember.

## Two places to type commands

VaultOps lives in two places. Don't mix them up:

| Where | What to type | What it's for |
|-------|-------------|---------------|
| **Your terminal** | `vaultops add` `vaultops open` `vaultops update` | Setup and management |
| **Claude Code chat** | `/vault:today` `/vault:task` `/vault:docs` | Daily work with Claude |

**Terminal** = you're talking to VaultOps.
**Claude Code** = you're talking to Claude, and VaultOps helps behind the scenes.

## What Claude can do once it has a notebook

**Tasks** — Claude tracks what you're working on automatically.
Just describe work in the chat — Claude creates `EXE-###` tasks and updates them as you go.

**Docs** — Run `/vault:docs` and Claude reads your whole codebase, then writes architecture
docs, API reference, and a runbook directly into Obsidian.

**Analysis** — Run `/vault:enrich EXE-042` and Claude produces full BA, Designer,
System Analyst, Developer, and QA analysis for any task.

**Sprints & meetings** — Planning, burndown, retros, meeting notes with action items.
All in your vault, all linked together.

## The slash commands (use in Claude Code chat)

| Command | What it does |
|---------|-------------|
| `/vault:today` | What am I working on today? |
| `/vault:task` | Create or update a task |
| `/vault:docs` | Generate full project documentation |
| `/vault:enrich` | Deep analysis: BA → Designer → Dev → QA |
| `/vault:plan` | Write a work plan |
| `/vault:kanban` | See tasks as a board |
| `/vault:sprint` | Sprint planning and burndown |
| `/vault:meeting` | Meeting notes with action items |
| `/vault:retro` | Sprint retrospective |
| `/vault:context` | Show everything Claude knows about this project |

[All 28 commands →](CLAUDE.md)

## The terminal commands (use in your terminal)

```bash
vaultops add        # Open a notebook for this project  ← do this first
vaultops open       # Open your notebook in Obsidian
vaultops status     # See all your projects
vaultops update     # Get the latest version
vaultops dashboard  # Overview of all projects in terminal
vaultops uninstall  # Remove VaultOps
```

## Where does everything live?

Your notebook is plain markdown files at `~/.vaultops/vault/<project-name>/`.
Open it in Obsidian to see tasks as a graph, run Dataview queries, and browse docs.

```
08-Execution/
  Task Board.md        ← all your tasks in one table
  Tasks/EXE-001.md     ← each task as its own file
  Execution Journal.md ← auto-written log of what Claude did
_meetings/             ← meeting notes and action items
00-Overview/           ← AI-generated project docs
```

## Tech notes (for contributors)

- Runtime: TypeScript compiled to JS, Node.js stdlib only — zero npm dependencies
- Data: standard Obsidian markdown with YAML frontmatter
- Works fully offline — no telemetry, no cloud, no accounts

[CONTRIBUTING.md](CONTRIBUTING.md) · [MIT License](LICENSE)

---

If VaultOps saves you time — [Buy Me a Coffee](https://buymeacoffee.com/vaultops) · Star this repo
