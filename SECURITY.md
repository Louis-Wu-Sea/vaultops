# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in VaultOps, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email: **andrii@dispatching-ai.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 1 week
- **Fix release**: as soon as practical, depending on severity

## Scope

This policy covers:
- `scripts/vaultops_mcp_server.py` — MCP server
- `scripts/vault_cli.js` — CLI tool
- `scripts/hooks/` — Claude Code hooks
- `install.sh` — installer script

## Design Principles

VaultOps is designed with security in mind:
- **Local-first**: all data stored in local Obsidian markdown files
- **No network calls**: core functionality works fully offline
- **No dependencies**: MCP server (Python stdlib) and CLI (Node.js stdlib) have zero third-party dependencies
- **No telemetry**: no usage tracking or analytics
