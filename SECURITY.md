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
- `src/` — TypeScript MCP server and hooks (compiled to `scripts/compiled/`)
- `scripts/vault_cli.js` — CLI tool
- `install.sh` — installer script

## Design Principles

VaultOps is designed with security in mind:
- **Local-first**: all data stored in local Obsidian markdown files
- **No network calls**: core functionality works fully offline
- **No runtime dependencies**: MCP server (TypeScript/Node.js stdlib) and CLI (Node.js stdlib) have zero third-party runtime dependencies
- **No telemetry**: no usage tracking or analytics
