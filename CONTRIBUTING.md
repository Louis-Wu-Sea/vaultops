# Contributing to VaultOps

Thank you for your interest in contributing to VaultOps! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js** >= 18
- **Python** >= 3.8
- **Obsidian** (recommended, for viewing vault output)
- **Claude Code** (for testing skills and MCP tools)

### Getting Started

```bash
git clone https://github.com/Louis-Wu-Sea/vaultops.git
cd vaultops

# Test CLI
node scripts/vault_cli.js --help

# Test MCP server (verify tool count)
python3 -c "import sys; sys.path.insert(0,'scripts'); import vaultops_mcp_server as m; print(len(m._tools_list_result()['tools']),'tools')"

# Test on a sample project
node scripts/vault_cli.js init --vault-root /tmp/test-vault
```

## Architecture

```
scripts/
  vault_cli.js              # CLI (Node.js, stdlib only — no npm deps)
  vaultops_mcp_server.py    # MCP server (Python, stdlib only — no pip deps)
  cli/dashboard/            # TUI dashboard components
  hooks/                    # Claude Code hooks
skills/                     # Slash command definitions (SKILL.md files)
install.sh                  # One-command installer
```

### Key Constraints

- **MCP server**: Python stdlib only. No `pip install` dependencies.
- **CLI**: Node.js stdlib only. No `npm install` dependencies.
- **Data format**: Obsidian-compatible markdown with YAML frontmatter.
- **Links**: Wiki-links (`[[EXE-001]]`) for task relationships.
- **Diagrams**: Mermaid in markdown (Obsidian renders natively).

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/Louis-Wu-Sea/vaultops/issues) first
2. Use the bug report template when creating a new issue
3. Include your Node.js version, Python version, and OS

### Adding a New MCP Tool

1. Add the tool handler in `scripts/vaultops_mcp_server.py`
2. Register it in the `_tools_list_result()` function
3. Follow the existing patterns for input schema and error handling
4. Update `CLAUDE.md` with the new tool documentation
5. Test with Claude Code: verify the tool appears and works

### Adding a New Skill

1. Create `skills/<skill-name>/SKILL.md`
2. Include frontmatter with `description`, `filePattern`, and `bashPattern`
3. Write the skill prompt in the body
4. Test with Claude Code: `/vault:<skill-name>`

### Code Style

- **Python**: Follow PEP 8. Use type hints where practical.
- **JavaScript**: No semicolons required (the codebase uses them). Single quotes preferred.
- **Markdown**: Use YAML frontmatter for structured data. Keep files Obsidian-friendly.

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Verify: MCP server loads, CLI runs, tool count is correct
5. Open a PR with a clear description of what and why

### Branch Naming

- `feat/` — new features
- `fix/` — bug fixes
- `docs/` — documentation changes
- `refactor/` — code restructuring

### Commit Messages

Use conventional commits:

```
feat: add sprint velocity chart tool
fix: handle missing vault root gracefully
docs: update MCP tool reference
```

## Community

- Be respectful and constructive
- See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community guidelines
- For security issues, see [SECURITY.md](SECURITY.md)
