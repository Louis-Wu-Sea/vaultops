#!/usr/bin/env node
'use strict';

// ┌─────────────────────────────────────────────────────────────────────┐
// │  VaultOps — Claude Code plugin for Obsidian-based task management  │
// │  https://github.com/Louis-Wu-Sea/vaultops                         │
// │  MIT License                                                       │
// └─────────────────────────────────────────────────────────────────────┘

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runDashboard } = require('./cli/dashboard/controller');

const DEFAULT_VAULT_ROOT = path.join(os.homedir(), '.vaultops', 'vault');

const installDir = process.env.VAULTOPS_INSTALL_DIR
  ? path.resolve(process.env.VAULTOPS_INSTALL_DIR)
  : path.join(os.homedir(), '.vaultops');
const stateDir = path.join(installDir, 'state');
const projectsPath = path.join(stateDir, 'projects.json');
const reposPath = path.join(stateDir, 'repos.json');
const localBinDir = path.join(os.homedir(), '.local', 'bin');
const localBinLink = path.join(localBinDir, 'vaultops');

const DOC_SECTIONS = [
  '00-Overview',
  '01-Requirements',
  '02-Architecture',
  '03-Design',
  '04-Development',
  '05-QA',
  '06-Operations',
  '07-References',
  '09-Interfaces',
  '10-Security',
  '11-Marketing',
];

const EXEC_FILES = {
  'Task Board.md':
    '| ID | Task | Status | Priority | Owner | Details | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n',
  'Work Plans.md': '# Work Plans\n',
  'Execution Journal.md': '# Execution Journal\n',
  'Current Stage.md': '# Current Stage\n\n## Stage Summary\n\nNo stage set yet.\n',
  'Context State.md': '# Context State\n\n## Current Context Snapshot\n\nNot initialized yet.\n',
};

const ANSI = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  blue:     '\x1b[34m',        // readable on both light and dark terminals
  red:      '\x1b[31m',        // errors — always high contrast
  magenta:  '\x1b[35m',        // special accents
  boldBlue: '\x1b[1;34m',      // primary premium accent (banner ◆)
  // Aliases mapped to cross-terminal-safe values
  cyan:          '\x1b[1;34m', // was 36 (invisible on light) → bold blue
  green:         '\x1b[1m',    // was 32 (faint on light)     → bold
  yellow:        '\x1b[1m',    // was 33 (invisible on light)  → bold
  brightCyan:    '\x1b[34m',   // was 96 (invisible on light)  → plain blue
  brightMagenta: '\x1b[1;35m', // was 95                       → bold magenta
};

function color(text, tone) {
  if (!process.stdout.isTTY || !tone) return text;
  return `${ANSI[tone] || ''}${text}${ANSI.reset}`;
}

function info(text) { console.log(`  ${color('·', 'dim')} ${text}`); }
function ok(text)   { console.log(`  ${color('✓', 'bold')} ${text}`); }
function warn(text) { console.log(`  ${color('⚠', 'bold')} ${text}`); }
function fail(text) { console.error(`  ${color('✗', 'red')} ${text}`); }

// ── Visual helpers (TTY-guarded) ─────────────────────────────────────────

// Strip ANSI escape codes to get the visible length of a string
function _visLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; } // eslint-disable-line no-control-regex
function _strPad(s, n) { return s + ' '.repeat(Math.max(0, n - _visLen(s))); }

/** Bordered card:  ╔═══ label ═══╗  ║ content ║  ╚═════════════╝ */
function box(lines, label) {
  const W = 50; // total width including ╔ and ╗
  const inner = W - 2;
  const arr = Array.isArray(lines) ? lines : [lines];
  if (!process.stdout.isTTY) {
    if (label) console.log(`\n  ── ${label} ──`);
    for (const l of arr) console.log(`  ${l}`);
    console.log('');
    return;
  }
  let top;
  if (label) {
    const mid = `══ ${label} `;
    top = `╔${mid}${'═'.repeat(Math.max(0, inner - mid.length))}╗`;
  } else {
    top = `╔${'═'.repeat(inner)}╗`;
  }
  console.log(`  ${color(top, 'dim')}`);
  for (const l of arr) {
    console.log(`  ${color('║', 'dim')}${_strPad(' ' + l, inner)}${color('║', 'dim')}`);
  }
  console.log(`  ${color(`╚${'═'.repeat(inner)}╝`, 'dim')}`);
}

/** Copy-paste command box:  ┌── label ──┐  │ cmd │  └──────────┘ */
function cmdBox(cmd, label) {
  const W = 46; // total width including ┌ and ┐
  const inner = W - 2;
  if (!process.stdout.isTTY) {
    if (label) console.log(`  ${label}`);
    console.log(`  ${cmd}`);
    return;
  }
  let top;
  if (label) {
    const mid = `── ${label} `;
    top = `┌${mid}${'─'.repeat(Math.max(0, inner - mid.length))}┐`;
  } else {
    top = `┌${'─'.repeat(inner)}┐`;
  }
  console.log(`  ${color(top, 'dim')}`);
  console.log(`  ${color('│', 'dim')}${color(_strPad('  ' + cmd, inner), 'bold')}${color('│', 'dim')}`);
  console.log(`  ${color(`└${'─'.repeat(inner)}┘`, 'dim')}`);
}

/** Brand header — call once at the start of cmdInstall */
function banner() {
  if (!process.stdout.isTTY) {
    console.log('◆ VAULTOPS — Project brain for Claude Code');
    return;
  }
  const v = 'v1.0.1';
  const fill = '─'.repeat(Math.max(0, 34 - v.length));
  console.log('');
  console.log(`  ${color('◆', 'boldBlue')}  ${color('VAULTOPS', 'bold')}  ${color(`${fill} ${v}`, 'dim')}`);
  console.log(`     ${color('Project brain for Claude Code', 'dim')}`);
  console.log(`  ${color('─'.repeat(50), 'dim')}`);
  console.log('');
}

function sanitizeRepoId(repoId) {
  return String(repoId || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '') || 'repo_default';
}

function asBool(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'y' || text === 'on';
}

function parseOptions(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--') { opts._.push(...args.slice(i + 1)); break; }
    if (!token.startsWith('--')) { opts._.push(token); continue; }
    const keyValue = token.slice(2).split('=', 2);
    const key = keyValue[0];
    if (keyValue.length === 2) { opts[key] = keyValue[1]; continue; }
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { opts[key] = next; i += 1; } else { opts[key] = true; }
  }
  return opts;
}

function ensureDir(target) { fs.mkdirSync(target, { recursive: true }); }

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadProjects() { return readJson(projectsPath, { version: 1, projects: [] }); }
function saveProjects(registry) { writeJson(projectsPath, registry); }

/**
 * Locate the Claude Code CLI binary.
 * Checks known install locations, then falls back to PATH via `which`.
 * Returns the absolute path, or null if not found.
 */
function findClaudeCLI() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ }
  }
  // Try PATH via `which`
  try {
    const result = spawnSync('which', ['claude'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch { /* no which */ }
  return null;
}

function createProjectKey(repoId, projectPath) {
  const digest = crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 8);
  return `${sanitizeRepoId(repoId)}-${digest}`;
}

function upsertProject(projectMeta) {
  const registry = loadProjects();
  const normalizedPath = path.resolve(projectMeta.path);
  const now = new Date().toISOString();
  const index = registry.projects.findIndex((e) => path.resolve(e.path) === normalizedPath);
  const key = projectMeta.key || createProjectKey(projectMeta.repoId, normalizedPath);

  if (index >= 0) {
    const merged = { ...registry.projects[index], ...projectMeta, path: normalizedPath, key, updatedAt: now };
    registry.projects[index] = merged;
    saveProjects(registry);
    return merged;
  }

  const created = { ...projectMeta, path: normalizedPath, key, addedAt: now, updatedAt: now };
  registry.projects.push(created);
  saveProjects(registry);
  return created;
}

function parseEnvFile(filePath) {
  const output = {};
  if (!fs.existsSync(filePath)) return output;
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'EACCES') return output; // file exists but unreadable — skip silently
    throw e;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    output[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return output;
}

function resolveProjectPath(rawPath, fallback) {
  return path.resolve(rawPath || fallback || process.cwd());
}

function hasCommand(command) {
  return spawnSync('which', [command], { stdio: 'ignore', shell: false }).status === 0;
}

function ensureLauncher() {
  ensureDir(path.join(installDir, 'bin'));
  const launcherPath = path.join(installDir, 'bin', 'vaultops');
  const launcher = `#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [ -h "\${SOURCE}" ]; do
  SOURCE_DIR="$(cd -P "$(dirname "\${SOURCE}")" && pwd)"
  TARGET="$(readlink "\${SOURCE}")"
  if [[ "\${TARGET}" != /* ]]; then SOURCE="\${SOURCE_DIR}/\${TARGET}"; else SOURCE="\${TARGET}"; fi
done
SCRIPT_DIR="$(cd -P "$(dirname "\${SOURCE}")" && pwd)"
ROOT_DIR="$(cd "\${SCRIPT_DIR}/.." && pwd)"
exec env VAULTOPS_INSTALL_DIR="\${ROOT_DIR}" node "\${ROOT_DIR}/scripts/vault_cli.js" "$@"
`;
  fs.writeFileSync(launcherPath, launcher, 'utf8');
  fs.chmodSync(launcherPath, 0o755);

  ensureDir(localBinDir);
  try { const stat = fs.lstatSync(localBinLink); if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(localBinLink); } catch {}
  fs.symlinkSync(launcherPath, localBinLink);
  return launcherPath;
}

function pathContains(targetPath) {
  return String(process.env.PATH || '').split(path.delimiter).includes(targetPath);
}


// ── vault install ────────────────────────────────────────────────────────

function cmdInstall(opts) {
  banner();
  const launcher = ensureLauncher();
  ensureDir(stateDir);

  console.log(`  ${color('✓', 'green')}  CLI installed ${color('→', 'dim')} ${localBinLink}`);
  if (!pathContains(localBinDir)) {
    warn(`${localBinDir} is not in PATH.`);
    console.log(`  Add to shell profile: export PATH="${localBinDir}:$PATH"`);
  }
  console.log('');

  box([
    `  ${color('cd /path/to/repo', 'bold')}`,
    `  ${color('vaultops add', 'bold')}`,
  ], 'Next · Register project');
  console.log('');

  cmdOpen({ _: [] });
}


// ── vault repo ──────────────────────────────────────────────────────────

function loadRepos() { return readJson(reposPath, { version: 1, repos: [] }); }
function saveRepos(registry) { writeJson(reposPath, registry); }

function upsertRepo(meta) {
  const registry = loadRepos();
  const normalizedPath = path.resolve(meta.path);
  const now = new Date().toISOString();
  const key = meta.key || createProjectKey(meta.repoId, normalizedPath);
  const index = registry.repos.findIndex((e) => path.resolve(e.path) === normalizedPath);

  if (index >= 0) {
    const merged = { ...registry.repos[index], ...meta, path: normalizedPath, key, updatedAt: now };
    registry.repos[index] = merged;
    saveRepos(registry);
    return merged;
  }

  const created = { ...meta, path: normalizedPath, key, addedAt: now, updatedAt: now };
  registry.repos.push(created);
  saveRepos(registry);
  return created;
}

function cmdRepo(opts) {
  const subCmd = opts._?.[0] || 'status';

  switch (subCmd) {
    case 'init': return cmdRepoInit(opts);
    case 'sync': return cmdRepoSync(opts);
    case 'status': case 'list': return cmdRepoStatus(opts);
    default: throw new Error(`Unknown repo command: ${subCmd}. Use: vaultops repo init|sync|status`);
  }
}

function cmdRepoInit(opts) {
  const repoPath = path.resolve(opts._?.[1] || process.cwd());
  const remote = opts.remote || '';
  const repoId = sanitizeRepoId(opts['repo-id'] || path.basename(repoPath));
  const autoCommit = opts.autocommit || 'session';

  info(`Initializing standalone doc repo: ${repoPath}`);

  // 1. Create Obsidian vault structure (vault IS the repo)
  const execDir = path.join(repoPath, '08-Execution');
  ensureDir(execDir);
  ensureDir(path.join(execDir, 'Tasks'));
  ensureDir(path.join(execDir, 'Role Outputs'));

  for (const [filename, template] of Object.entries(EXEC_FILES)) {
    const filePath = path.join(execDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, template, 'utf8');
      ok(`Created ${filename}`);
    }
  }

  for (const section of DOC_SECTIONS) {
    ensureDir(path.join(repoPath, section));
  }
  ok('Obsidian vault structure ready');

  // 2. Write .vaultops/config.env
  const vaultopsDir = path.join(repoPath, '.vaultops');
  ensureDir(vaultopsDir);
  const configEnvPath = path.join(vaultopsDir, 'config.env');
  const existingConfig = parseEnvFile(configEnvPath);
  const merged = {
    ...existingConfig,
    VAULTOPS_PROJECT_VAULT_ROOT: repoPath,
    VAULTOPS_PROJECT_VAULT_PATH: repoPath,
    VAULTOPS_REPO_ID: repoId,
    VAULTOPS_DOC_REPO: 'true',
    VAULTOPS_AUTOCOMMIT: autoCommit,
  };
  const configContent = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(configEnvPath, configContent, 'utf8');
  ok('Written config.env (doc-repo mode)');

  // 3. Git init
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    const initResult = spawnSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
    if (initResult.status === 0) {
      ok('Initialized git repository');
    } else {
      warn('Failed to init git — you may need to do it manually');
    }
  } else {
    info('Git repository already exists');
  }

  // 4. Add remote if provided
  if (remote) {
    // Validate remote URL: only allow HTTPS, SSH, and git@ protocols
    const SAFE_REMOTE_RE = /^(https?:\/\/[^\s;`|&]+|git@[a-zA-Z0-9._-]+:[^\s;`|&]+|ssh:\/\/[^\s;`|&]+)$/;
    if (!SAFE_REMOTE_RE.test(remote)) {
      throw new Error(`Invalid remote URL: ${remote}\nOnly HTTPS, SSH (git@...), and ssh:// URLs are allowed.`);
    }
    // Check if origin already exists
    const remoteCheck = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, stdio: 'pipe' });
    if (remoteCheck.status === 0) {
      info(`Remote 'origin' already set to: ${remoteCheck.stdout.toString().trim()}`);
    } else {
      const addRemote = spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: repoPath, stdio: 'pipe' });
      if (addRemote.status === 0) {
        ok(`Added remote origin: ${remote}`);
      } else {
        warn('Failed to add remote — check the URL');
      }
    }
  }

  // 5. Create .gitignore
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '.vaultops/\n.DS_Store\n', 'utf8');
    ok('Created .gitignore');
  } else {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    if (!gi.includes('.vaultops/')) {
      fs.appendFileSync(gitignorePath, '\n.vaultops/\n');
      ok('Added .vaultops/ to .gitignore');
    }
  }

  // 6. Initial commit
  spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  const commitResult = spawnSync('git', ['commit', '-m', 'vault: init doc repo'], { cwd: repoPath, stdio: 'pipe' });
  if (commitResult.status === 0) {
    ok('Created initial commit');
  }

  // 7. Register in repos.json
  const entry = upsertRepo({
    path: repoPath,
    repoId,
    gitRemote: remote || '',
    autoCommit,
    type: 'doc-repo',
  });
  ok(`Registered doc repo: ${entry.key}`);

  printBox([
    `Doc repo ready: ${repoPath}`,
    `Repo ID: ${repoId}`,
    remote ? `Remote: ${remote}` : 'No remote (add with: git remote add origin <url>)',
    `Auto-commit: ${autoCommit}`,
    '',
    'Use all VaultOps tools — /task, /plan, /kanban, /docs, etc.',
    'Sync to remote: vaultops repo sync',
  ], 'DOC REPO INITIALIZED');
}

function cmdRepoSync(opts) {
  const repoPath = path.resolve(opts._?.[1] || process.cwd());

  // Find in repos.json
  const registry = loadRepos();
  const entry = registry.repos.find((r) => path.resolve(r.path) === repoPath);
  if (!entry) {
    throw new Error(`Not a registered doc repo: ${repoPath}. Run 'vaultops repo init' first.`);
  }

  info(`Syncing doc repo: ${repoPath}`);

  // Check for remote
  const remoteCheck = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, stdio: 'pipe' });
  if (remoteCheck.status !== 0) {
    throw new Error('No remote configured. Add one: git remote add origin <url>');
  }

  // Get current branch
  const branchResult = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, stdio: 'pipe' });
  const branch = branchResult.stdout.toString().trim() || 'main';

  // Stage and commit any pending changes
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, stdio: 'pipe' });
  if (status.stdout.toString().trim()) {
    spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    spawnSync('git', ['commit', '-m', `vault: sync ${now}`], { cwd: repoPath, stdio: 'pipe' });
    ok('Committed pending changes');
  }

  // Validate branch name
  const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  // Pull
  info('Pulling from remote...');
  const pull = spawnSync('git', ['pull', '--rebase', 'origin', branch], { cwd: repoPath, stdio: 'pipe', timeout: 30000 });
  if (pull.status !== 0) {
    const stderr = pull.stderr.toString();
    throw new Error(`Pull failed — resolve conflicts manually:\n${stderr}`);
  }
  ok('Pull complete');

  // Push
  info('Pushing to remote...');
  const push = spawnSync('git', ['push', 'origin', branch], { cwd: repoPath, stdio: 'pipe', timeout: 30000 });
  if (push.status !== 0) {
    const stderr = push.stderr.toString();
    throw new Error(`Push failed:\n${stderr}`);
  }
  ok('Push complete');

  info('Sync done');
}

function cmdRepoStatus(opts) {
  const registry = loadRepos();
  if (!registry.repos.length) {
    info('No doc repos registered. Use: vaultops repo init [path] --remote <url>');
    return;
  }

  printBanner();
  console.log(color('  Standalone Doc Repos:', 'bold'));
  console.log('');

  for (const repo of registry.repos) {
    const exists = fs.existsSync(repo.path);
    const status = exists ? color('●', 'green') : color('○', 'red');
    console.log(`  ${status}  ${repo.repoId}`);
    console.log(`     Path: ${repo.path}`);
    if (repo.gitRemote) console.log(`     Remote: ${repo.gitRemote}`);
    console.log(`     Auto-commit: ${repo.autoCommit || 'session'}`);
    console.log('');
  }
}


// ── vault init ───────────────────────────────────────────────────────────

function cmdInit(opts) {
  const projectPath = resolveProjectPath(opts.path || opts._?.[0], process.cwd());
  const repoId = sanitizeRepoId(opts['repo-id'] || path.basename(projectPath));

  // Resolve vault root
  let vaultRoot = opts['vault-root'];
  if (!vaultRoot) {
    const configEnv = parseEnvFile(path.join(projectPath, '.vaultops', 'config.env'));
    vaultRoot = configEnv.VAULTOPS_PROJECT_VAULT_ROOT;
  }
  if (!vaultRoot) {
    vaultRoot = DEFAULT_VAULT_ROOT;
  }
  vaultRoot = path.resolve(vaultRoot);

  const vaultProject = path.join(vaultRoot, repoId);

  info(`Initializing VaultOps for: ${projectPath}`);
  info(`Vault root: ${vaultProject}`);

  // 1. Create Obsidian vault structure
  const execDir = path.join(vaultProject, '08-Execution');
  ensureDir(execDir);
  for (const [filename, template] of Object.entries(EXEC_FILES)) {
    const filePath = path.join(execDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, template, 'utf8');
      ok(`Created ${filename}`);
    }
  }

  for (const section of DOC_SECTIONS) {
    const sectionDir = path.join(vaultProject, section);
    ensureDir(sectionDir);
  }
  ok('Obsidian vault structure ready');

  // 2. Write .vaultops/config.env
  const vaultopsDir = path.join(projectPath, '.vaultops');
  ensureDir(vaultopsDir);
  const configEnvPath = path.join(vaultopsDir, 'config.env');
  const existingConfig = parseEnvFile(configEnvPath);
  const merged = {
    ...existingConfig,
    VAULTOPS_PROJECT_VAULT_ROOT: vaultRoot,
    VAULTOPS_REPO_ID: repoId,
  };
  const configContent = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(configEnvPath, configContent, 'utf8');
  fs.chmodSync(configEnvPath, 0o600);
  ok(`Written ${configEnvPath}`);

  // Ensure .vaultops/ is gitignored (contains secrets)
  const gitignorePath = path.join(projectPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    if (!gi.includes('.vaultops/')) {
      fs.appendFileSync(gitignorePath, '\n# VaultOps local config (may contain secrets)\n.vaultops/\n');
      ok('Added .vaultops/ to .gitignore');
    }
  }

  // 3. Register MCP server
  // Preferred: 'claude mcp add -s user' (user scope, no trust dialog required).
  // Fallback: write .mcp.json (project scope, requires trust dialog approval).
  const nodeBin = process.execPath; // absolute path of the node binary running this script
  const indexPath = path.join(installDir, 'scripts', 'compiled', 'index.js');
  const claudeBin = findClaudeCLI();
  if (claudeBin) {
    // Remove existing user-scope entry first (ignore errors)
    spawnSync(claudeBin, ['mcp', 'remove', 'vaultops', '-s', 'user'], { stdio: 'pipe' });
    const addResult = spawnSync(
      claudeBin,
      ['mcp', 'add', '-s', 'user', '-e', `VAULTOPS_PROJECTS_JSON=${projectsPath}`, '--', 'vaultops', nodeBin, indexPath],
      { stdio: 'pipe' },
    );
    if (addResult.status === 0) {
      ok('Registered MCP server at user scope (claude mcp add -s user)');
      // Remove stale vaultops entry from .mcp.json (old Python config or duplicate project-scope)
      // to prevent Claude Code from loading both configs simultaneously.
      const mcpJsonPath = path.join(projectPath, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        const mcpCfg = readJson(mcpJsonPath, { mcpServers: {} });
        if (mcpCfg.mcpServers && mcpCfg.mcpServers.vaultops) {
          delete mcpCfg.mcpServers.vaultops;
          writeJson(mcpJsonPath, mcpCfg);
          ok('Removed stale vaultops entry from .mcp.json (user-scope registration is active)');
        }
      }
    } else {
      warn(`claude mcp add failed: ${(addResult.stderr || addResult.stdout || '').toString().trim()}`);
      warn('Falling back to .mcp.json — approve in Claude Code trust dialog');
      _writeMcpJson(projectPath, nodeBin, indexPath, projectsPath);
    }
  } else {
    _writeMcpJson(projectPath, nodeBin, indexPath, projectsPath);
  }

  function _writeMcpJson(projPath, nodeB, idxPath, projsPath) {
    const mcpJsonPath = path.join(projPath, '.mcp.json');
    const mcpConfig = readJson(mcpJsonPath, { mcpServers: {} });
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers.vaultops = {
      type: 'stdio',
      command: nodeB,
      args: [idxPath],
      env: { VAULTOPS_PROJECTS_JSON: projsPath },
    };
    writeJson(mcpJsonPath, mcpConfig);
    ok(`Written ${mcpJsonPath} (studio mode — approve in Claude Code trust dialog)`);
  }

  // 4. Install skills globally to ~/.claude/skills/ (once, not per-repo)
  const skillsSource = path.join(installDir, 'skills');
  const skillsTarget = path.join(os.homedir(), '.claude', 'skills');
  if (fs.existsSync(skillsSource)) {
    const skillDirs = fs.readdirSync(skillsSource, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const dir of skillDirs) {
      const srcSkill = path.join(skillsSource, dir.name, 'SKILL.md');
      if (!fs.existsSync(srcSkill)) continue;
      const destDir = path.join(skillsTarget, dir.name);
      ensureDir(destDir);
      fs.copyFileSync(srcSkill, path.join(destDir, 'SKILL.md'));
    }
    ok(`Installed ${skillDirs.length} skills to ~/.claude/skills/ (global)`);
  } else {
    warn(`Skills source not found: ${skillsSource}`);
  }

  // 5. Register hooks in .claude/settings.json
  const claudeSettingsPath = path.join(projectPath, '.claude', 'settings.json');
  const claudeSettings = readJson(claudeSettingsPath, {});
  if (!claudeSettings.hooks) claudeSettings.hooks = {};

  // Remove all legacy Python VaultOps hook entries (migration: Python → Node.js).
  // Python hooks used underscores + .py, e.g. session_init.py, pre_context.py.
  for (const event of Object.keys(claudeSettings.hooks)) {
    claudeSettings.hooks[event] = claudeSettings.hooks[event].filter(
      (h) => !(h.hooks && h.hooks.some(
        (hh) => hh.command && hh.command.includes('.vaultops/scripts/hooks/') && hh.command.includes('.py'),
      )),
    );
  }

  // Helper: register or update a hook entry
  // Use $HOME so the command works on any machine (no hardcoded absolute paths)
  const registerHook = (event, matcher, scriptName) => {
    if (!claudeSettings.hooks[event]) claudeSettings.hooks[event] = [];
    const hookCmd = `node "$HOME/.vaultops/scripts/compiled/hooks/${scriptName}"`;
    const existingIdx = claudeSettings.hooks[event].findIndex(
      (h) => h.hooks && h.hooks.some((hh) => hh.command && hh.command.includes(scriptName)),
    );
    const entry = matcher
      ? { matcher, hooks: [{ type: 'command', command: hookCmd }] }
      : { hooks: [{ type: 'command', command: hookCmd }] };
    if (existingIdx >= 0) {
      // Update existing (e.g., expand matcher from Edit|Write to Edit|Write|Bash)
      claudeSettings.hooks[event][existingIdx] = entry;
    } else {
      claudeSettings.hooks[event].push(entry);
    }
  };

  // SessionStart hook — initialize brain state + load active tasks
  registerHook('SessionStart', null, 'session-init.js');

  // UserPromptSubmit hook — intent classification + auto-task creation
  registerHook('UserPromptSubmit', null, 'prompt-analyzer.js');

  // PreToolUse hook — inject context + track files + architecture detection
  registerHook('PreToolUse', 'Edit|Write|Bash', 'pre-context.js');

  // PostToolUse hook — log steps + collect evidence (tests, commits)
  registerHook('PostToolUse', 'Edit|Write|Bash', 'post-log.js');

  // Stop hook — auto-complete tasks + rich session receipt
  registerHook('Stop', null, 'session-summary.js');

  // Stop hook — vault janitor (runs after session_summary, cleans up garbage)
  registerHook('Stop', null, 'vault-janitor.js');

  // Permissions — allow VaultOps runtime commands without prompting
  if (!claudeSettings.permissions) claudeSettings.permissions = {};
  if (!claudeSettings.permissions.allow) claudeSettings.permissions.allow = [];
  const vaultopsAllows = [
    'Bash(node *)',
    'Bash(vaultops *)',
    'Bash(ls */.vaultops/*)',
    'Bash(ls */.vaultops/vault/*)',
    'Bash(cat */.vaultops/*)',
    'mcp__vaultops__*',
  ];
  for (const rule of vaultopsAllows) {
    if (!claudeSettings.permissions.allow.includes(rule)) {
      claudeSettings.permissions.allow.push(rule);
    }
  }

  writeJson(claudeSettingsPath, claudeSettings);
  ok('Registered VaultOps hooks and permissions in .claude/settings.json');

  // Ensure machine-local files with absolute paths are gitignored
  {
    const localFiles = ['.claude/settings.json', '.mcp.json'];
    const giPath = path.join(projectPath, '.gitignore');
    let giContent = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    const toAdd = localFiles.filter((f) => !giContent.split('\n').some((line) => line.trim() === f));
    if (toAdd.length > 0) {
      const block = '\n# VaultOps: machine-local files (contain absolute paths)\n' + toAdd.join('\n') + '\n';
      fs.appendFileSync(giPath, block);
      ok(`Added to .gitignore: ${toAdd.join(', ')}`);
    }
  }

  // 6. Update AGENTS.md
  const agentsPath = path.join(projectPath, 'AGENTS.md');
  const vaultopsSection = `<!-- vaultops-onboarding -->
## VaultOps

- Vault root: ${vaultRoot}
- Project: ${repoId}
- MCP: vaultops (stdio, local)
- Skills: /vault:today /vault:plan /vault:task /vault:kanban /vault:docs /vault:enrich /vault:ba /vault:designer /vault:sysanalyst /vault:dev /vault:qa /vault:sprint /vault:context
- Task tracking: ${vaultProject}/08-Execution/

Use mcp__vaultops__* tools for all vault operations (get_context, create_task, update_task, log_step, etc.). Do NOT use mcp__obsidian__* tools for VaultOps workflow — they point to a different vault with no access to VaultOps data. Skills are available as /slash-commands in Claude Code.
<!-- /vaultops-onboarding -->`;

  if (fs.existsSync(agentsPath)) {
    let content = fs.readFileSync(agentsPath, 'utf8');
    if (content.includes('<!-- vaultops-onboarding -->')) {
      content = content.replace(
        /<!-- vaultops-onboarding -->[\s\S]*?<!-- \/vaultops-onboarding -->/,
        vaultopsSection,
      );
    } else {
      content = content.trimEnd() + '\n\n' + vaultopsSection + '\n';
    }
    fs.writeFileSync(agentsPath, content, 'utf8');
  } else {
    fs.writeFileSync(agentsPath, `# AGENTS\n\n${vaultopsSection}\n`, 'utf8');
  }
  ok('Updated AGENTS.md');

  // 6. Register in projects.json
  upsertProject({
    key: createProjectKey(repoId, projectPath),
    path: projectPath,
    repoId,
    vaultRoot,
    lastInitAt: new Date().toISOString(),
  });
  ok('Project registered');

  // Done
  console.log('');
  console.log('');
  box([
    `${color('✓', 'green')}  VaultOps ready  ·  ${color(repoId, 'bold')}`,
    `   Vault    ${vaultProject}`,
    `   Skills   18 commands active in Claude Code`,
  ]);
  console.log('');
  console.log(`  ${color('→', 'dim')} Start here — generate project docs:`);
  cmdBox('/vault:docs');
  console.log(`    AI scans your code ${color('→', 'dim')} writes architecture,`);
  console.log(`    API docs, runbook, codebase map to Obsidian.`);
  console.log('');
  console.log(`  ${color('─── All skills ────────────────────────────────', 'dim')}`);
  console.log(`   ${color('/vault:docs', 'bold')}      Generate full project documentation  ${color('← start', 'dim')}`);
  console.log(`   ${color('/vault:today', 'bold')}     Daily task dashboard`);
  console.log(`   ${color('/vault:task', 'bold')}      Create, update, link tasks`);
  console.log(`   ${color('/vault:plan', 'bold')}      Write a work plan`);
  console.log(`   ${color('/vault:kanban', 'bold')}    Visual task board`);
  console.log(`   ${color('/vault:sprint', 'bold')}    Sprint planning & burndown`);
  console.log(`   ${color('/vault:enrich', 'bold')}    BA → Designer → Dev → QA analysis`);
  console.log(`   ${color('/vault:context', 'bold')}   Full project context check`);
  console.log('');
  console.log(`   ${color('vaultops open', 'bold')}    Open Obsidian vault`);
  console.log('');
}


// ── vault add ────────────────────────────────────────────────────────────

function cmdAdd(opts) {
  const projectPath = resolveProjectPath(opts.path || opts._?.[0], process.cwd());
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPath}`);
  }

  info(`Adding project: ${projectPath}`);

  // Delegate to vault init with the same opts
  opts.path = projectPath;
  cmdInit(opts);
}




// ── vault update ─────────────────────────────────────────────────────────

const DIST_URL = process.env.VAULTOPS_DIST_URL || 'https://github.com/Louis-Wu-Sea/vaultops/releases/latest/download/vaultops.tar.gz';

function cmdUpdate(_opts) {
  info('Checking for updates...');

  // Step 1: Download tarball and checksum to temp files, verify before extracting
  const tmpTar = path.join(os.tmpdir(), `vaultops-update-${Date.now()}.tar.gz`);
  const tmpSum = `${tmpTar}.sha256`;

  try {
    const dlTar = spawnSync(
      'curl', ['-fsSL', '--output', tmpTar, DIST_URL],
      { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (dlTar.status !== 0) {
      fail('Download failed. Check your internet connection and try again.');
      process.exit(1);
    }

    const dlSum = spawnSync(
      'curl', ['-fsSL', '--output', tmpSum, `${DIST_URL}.sha256`],
      { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (dlSum.status !== 0) {
      fail('Could not download checksum file. Aborting to protect integrity.');
      process.exit(1);
    }

    // Rewrite checksum file to reference the temp tarball path (shasum -c needs matching filename)
    const sumContent = fs.readFileSync(tmpSum, 'utf8').trim();
    const expectedHash = sumContent.split(/\s+/)[0];
    const verify = spawnSync(
      'bash', ['-c', `shasum -a 256 "${tmpTar}" | awk '{print $1}'`],
      { encoding: 'utf8' },
    );
    const actualHash = (verify.stdout || '').trim();
    if (!expectedHash || actualHash !== expectedHash) {
      fail(`Checksum mismatch — download may be corrupted or tampered.\n  expected: ${expectedHash}\n  got:      ${actualHash}`);
      process.exit(1);
    }

    const extract = spawnSync(
      'tar', ['xz', '-C', installDir, '-f', tmpTar],
      { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (extract.status !== 0) {
      fail('Extraction failed.');
      process.exit(1);
    }
  } finally {
    try { fs.unlinkSync(tmpTar); } catch {}
    try { fs.unlinkSync(tmpSum); } catch {}
  }

  ok('Runtime files updated (scripts, MCP server)');

  // Step 2: Re-install skills to ~/.claude/skills/
  const skillsSource = path.join(installDir, 'skills');
  const skillsTarget = path.join(os.homedir(), '.claude', 'skills');
  let skillCount = 0;
  if (fs.existsSync(skillsSource)) {
    const skillDirs = fs.readdirSync(skillsSource, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const dir of skillDirs) {
      const srcSkill = path.join(skillsSource, dir.name, 'SKILL.md');
      if (!fs.existsSync(srcSkill)) continue;
      ensureDir(path.join(skillsTarget, dir.name));
      fs.copyFileSync(srcSkill, path.join(skillsTarget, dir.name, 'SKILL.md'));
      skillCount += 1;
    }
    ok(`Updated ${skillCount} skills → ~/.claude/skills/`);
  }

  // Step 3: Migrate launcher from 'vault' → 'vaultops' and refresh symlink
  {
    const oldLink = path.join(localBinDir, 'vault');
    try {
      const stat = fs.lstatSync(oldLink);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(oldLink);
        info("Removed old 'vault' symlink → replaced with 'vaultops'");
      }
    } catch {}
    ensureLauncher();
    ok(`CLI launcher updated → ${localBinLink}`);
    if (!pathContains(localBinDir)) {
      warn(`${localBinDir} is not in PATH. Add: export PATH="${localBinDir}:$PATH"`);
    }
  }

  // Step 4: Repair all registered project .claude/settings.json files
  //   - Fix hardcoded absolute home paths in hook commands → $HOME
  //   - Rename Bash(vault *) permission → Bash(vaultops *)
  const registry = readJson(projectsPath, { version: 1, projects: [] });
  const vaultopsAllows = [
    'Bash(python3 *)', 'Bash(python *)', 'Bash(vaultops *)',
    'Bash(ls */.vaultops/*)', 'Bash(ls */.vaultops/vault/*)',
    'Bash(cat */.vaultops/*)', 'mcp__vaultops__*',
  ];
  // Regex matches absolute home-dir segments like /Users/john/ or /home/john/
  const ABS_HOME_RE = /\/(?:Users|home)\/[^/]+\//g;
  let refreshed = 0;
  for (const proj of registry.projects || []) {
    const settingsPath = path.join(proj.path, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) continue;
    const settings = readJson(settingsPath, {});
    let changed = false;

    // Fix hook commands: replace absolute paths with $HOME
    for (const event of Object.values(settings.hooks || {})) {
      for (const group of Array.isArray(event) ? event : []) {
        for (const hook of group.hooks || []) {
          if (hook.command && ABS_HOME_RE.test(hook.command)) {
            hook.command = hook.command.replace(ABS_HOME_RE, '$HOME/');
            changed = true;
          }
          ABS_HOME_RE.lastIndex = 0; // reset stateful regex after each test
        }
      }
    }

    // Fix permissions: add new rules, remove old Bash(vault *) if present
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    // Remove old vault permission (renamed to vaultops)
    const oldVaultRule = 'Bash(vault *)';
    const oldIdx = settings.permissions.allow.indexOf(oldVaultRule);
    if (oldIdx !== -1) { settings.permissions.allow.splice(oldIdx, 1); changed = true; }
    // Add all current rules
    for (const rule of vaultopsAllows) {
      if (!settings.permissions.allow.includes(rule)) {
        settings.permissions.allow.push(rule);
        changed = true;
      }
    }

    if (changed) { writeJson(settingsPath, settings); refreshed++; }
  }
  if (refreshed > 0) ok(`Repaired settings for ${refreshed} project(s) (hook paths + permissions)`);

  // Step 5: Migrate .mcp.json Python entries → Node.js in all registered projects
  let mcpPatched = 0;
  for (const proj of registry.projects || []) {
    const mcpPath = path.join(proj.path, '.mcp.json');
    if (!fs.existsSync(mcpPath)) continue;
    const mcpCfg = readJson(mcpPath, { mcpServers: {} });
    const vo = mcpCfg.mcpServers && mcpCfg.mcpServers.vaultops;
    if (!vo) continue;
    const isPython =
      (vo.command && vo.command.includes('python')) ||
      (Array.isArray(vo.args) && vo.args.some((a) => String(a).endsWith('.py')));
    if (isPython) {
      mcpCfg.mcpServers.vaultops = {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(installDir, 'scripts', 'compiled', 'index.js')],
        env: { VAULTOPS_PROJECTS_JSON: projectsPath },
      };
      writeJson(mcpPath, mcpCfg);
      mcpPatched++;
    }
  }
  if (mcpPatched > 0) ok(`Migrated ${mcpPatched} project(s): .mcp.json Python → Node.js`);

  ok('VaultOps is up to date!');
  info('Vault content, project registry, and settings are unchanged.');
}

// ── vault status ─────────────────────────────────────────────────────────

function cmdStatus(opts) {
  const registry = loadProjects();
  const targetPath = opts.path || opts._?.[0];

  if (targetPath) {
    const resolved = resolveProjectPath(targetPath, process.cwd());
    const found = registry.projects.find((e) => path.resolve(e.path) === resolved);
    console.log(color('Vault status', 'bold'));
    console.log(`path: ${resolved}`);
    if (found) {
      console.log(`repo_id: ${found.repoId}`);
      console.log(`vault_root: ${found.vaultRoot || '-'}`);
      console.log(`last_init_at: ${found.lastInitAt || '-'}`);
    } else {
      warn('Project is not registered yet. Run: vaultops add');
    }
    return;
  }

  console.log(color('Vault projects', 'bold'));
  if (!registry.projects.length) {
    console.log('No projects registered yet. Run: vaultops add');
    return;
  }
  for (const entry of registry.projects) {
    console.log(`- ${color(entry.repoId, 'bold')}`);
    console.log(`  path: ${entry.path}`);
    console.log(`  vault: ${entry.vaultRoot || '-'}`);
    console.log(`  init: ${entry.lastInitAt || '-'}`);
  }
}


// ── vault uninstall ──────────────────────────────────────────────────────

function rmrf(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function removeMcpEntry(mcpJsonPath) {
  if (!fs.existsSync(mcpJsonPath)) return false;
  const cfg = readJson(mcpJsonPath, null);
  if (!cfg || !cfg.mcpServers || !cfg.mcpServers.vaultops) return false;
  delete cfg.mcpServers.vaultops;
  writeJson(mcpJsonPath, cfg);
  return true;
}

function removeAgentsSection(agentsPath) {
  if (!fs.existsSync(agentsPath)) return false;
  let content = fs.readFileSync(agentsPath, 'utf8');
  const start = content.indexOf('<!-- vaultops-onboarding -->');
  const end = content.indexOf('<!-- /vaultops-onboarding -->');
  if (start === -1 || end === -1) return false;
  content = content.slice(0, start).trimEnd() + '\n' + content.slice(end + '<!-- /vaultops-onboarding -->'.length).trimStart();
  fs.writeFileSync(agentsPath, content.trim() + '\n', 'utf8');
  return true;
}

function removeFromRegistry(projectPath) {
  if (!fs.existsSync(projectsPath)) return false;
  const registry = readJson(projectsPath, { version: 1, projects: [] });
  const before = registry.projects.length;
  registry.projects = registry.projects.filter(
    (p) => path.resolve(p.path) !== path.resolve(projectPath),
  );
  if (registry.projects.length === before) return false;
  writeJson(projectsPath, registry);
  return true;
}


function cmdUninstall(opts) {
  const purge = asBool(opts.purge);
  const yes = asBool(opts.yes) || asBool(opts.y);
  const projectPath = opts._?.[0] ? path.resolve(opts._?.[0]) : null;
  const removed = [];
  const warnings = [];

  // ── Per-project cleanup ───────────────────────────────────────────────
  if (projectPath) {
    if (!fs.existsSync(projectPath)) {
      warn(`Project path not found: ${projectPath}`);
    } else {
      // .vaultops/config.env
      const configEnv = path.join(projectPath, '.vaultops', 'config.env');
      if (rmrf(configEnv)) removed.push(configEnv);

      // Remove .vaultops/ dir if now empty
      const vaultopsDir = path.join(projectPath, '.vaultops');
      try {
        if (fs.existsSync(vaultopsDir) && fs.readdirSync(vaultopsDir).length === 0) {
          fs.rmdirSync(vaultopsDir);
          removed.push(vaultopsDir);
        }
      } catch {}

      // .mcp.json — remove vaultops entry
      if (removeMcpEntry(path.join(projectPath, '.mcp.json'))) {
        removed.push(path.join(projectPath, '.mcp.json') + ' (vaultops entry removed)');
      }

      // AGENTS.md — remove vaultops section
      if (removeAgentsSection(path.join(projectPath, 'AGENTS.md'))) {
        removed.push(path.join(projectPath, 'AGENTS.md') + ' (vaultops section removed)');
      }

      // Remove from registry
      if (removeFromRegistry(projectPath)) {
        removed.push(`registry: ${projectPath}`);
      }
    }
  }

  // ── Global CLI cleanup ────────────────────────────────────────────────
  // Symlink
  try {
    const stat = fs.lstatSync(localBinLink);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(localBinLink);
      removed.push(localBinLink);
    }
  } catch {}

  // Launcher
  const launcherPath = path.join(installDir, 'bin', 'vaultops');
  if (rmrf(launcherPath)) removed.push(launcherPath);
  // Also remove old 'vault' launcher if still present from pre-rename installs
  const oldLauncherPath = path.join(installDir, 'bin', 'vault');
  if (rmrf(oldLauncherPath)) removed.push(oldLauncherPath);

  // ── Purge installDir ──────────────────────────────────────────────────
  if (purge) {
    const vaultDataDir = path.join(installDir, 'vault');
    const hasVaultData = fs.existsSync(vaultDataDir) &&
      fs.readdirSync(vaultDataDir).length > 0;

    if (hasVaultData) {
      warnings.push(`Vault data will be deleted: ${vaultDataDir}`);
    }

    if (!yes) {
      console.log('');
      console.log(color('⚠  --purge will permanently delete:', 'bold'));
      console.log(`   ${installDir}`);
      if (hasVaultData) {
        console.log(color(`   including vault data at ${vaultDataDir}`, 'red'));
      }
      console.log('');
      console.log(`Run with ${color('--yes', 'bold')} to confirm: vaultops uninstall --purge --yes`);
      return;
    }

    if (rmrf(installDir)) removed.push(installDir);

    // Remove global skills from ~/.claude/skills/
    const globalSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    const vaultopsSkills = ['today', 'task', 'plan', 'kanban', 'docs', 'enrich', 'ba',
      'designer', 'sysanalyst', 'dev', 'qa', 'sprint', 'context', 'onboard'];
    for (const skill of vaultopsSkills) {
      const skillPath = path.join(globalSkillsDir, skill);
      if (rmrf(skillPath)) removed.push(skillPath);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  if (removed.length === 0) {
    info('Nothing to remove — VaultOps does not appear to be installed.');
    return;
  }

  for (const item of removed) ok(`Removed: ${item}`);

  if (!purge) {
    const vaultDataDir = path.join(installDir, 'vault');
    if (fs.existsSync(installDir)) {
      console.log('');
      info(`Vault data kept at: ${installDir}`);
      info(`To fully remove: ${color(`rm -rf ${installDir} ${localBinLink}`, 'cyan')}`);
      info(`Skills in ~/.claude/skills/ — remove manually if needed.`);
    }
  }

  ok('VaultOps uninstalled.');
}


// ── vault open ───────────────────────────────────────────────────────────

function cmdOpen(opts) {
  const projectPath = resolveProjectPath(opts.path || opts._?.[0], process.cwd());
  const registry = loadProjects();
  const found = registry.projects.find(
    (e) => path.resolve(e.path) === path.resolve(projectPath)
  );

  const vaultRoot = DEFAULT_VAULT_ROOT;
  // Always open the top-level vault directory to avoid "Vault not found" errors
  // when Obsidian hasn't registered the vault yet or when a specific file is missing
  const uri = `obsidian://open?path=${encodeURIComponent(vaultRoot)}`;

  info(`Opening Obsidian vault: ${vaultRoot}`);

  const { execFile } = require('child_process');

  const openUri = (cb) => {
    if (process.platform === 'darwin') {
      execFile('open', [uri], cb);
    } else if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', uri], cb);
    } else {
      execFile('xdg-open', [uri], cb);
    }
  };

  openUri((err) => {
    if (err) {
      info('Could not open via Obsidian URI — opening vault folder instead...');
      const folderOpener =
        process.platform === 'darwin' ? 'open' :
        process.platform === 'win32'  ? 'explorer' :
        'xdg-open';
      execFile(folderOpener, [vaultRoot], () => {});
    } else {
      ok('Obsidian opened.');
    }
  });
}

// ── vault dashboard ──────────────────────────────────────────────────────

async function cmdDashboard(opts) {
  await runDashboard(opts, { registryPath: projectsPath });
}


// ── vault config ──────────────────────────────────────────────────────────

const ENRICH_ROLES = ['ba', 'designer', 'sysanalyst', 'developer', 'qa'];
const VALID_MODELS = new Set(['inherit', 'haiku', 'sonnet', 'opus']);

function resolveProjectConfigPath(opts) {
  const projectPath = resolveProjectPath(opts.path, process.cwd());
  return path.join(projectPath, '.vaultops', 'config.env');
}

function writeEnvFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  const existing = parseEnvFile(filePath);
  const merged = { ...existing, ...data };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function cmdConfig(opts) {
  const subCmd = opts._[0];
  switch (subCmd) {
    case 'show': return cmdConfigShow(opts);
    case 'set':  return cmdConfigSet(opts);
    case 'reset': return cmdConfigReset(opts);
    default:
      console.log(color('vaultops config — manage VaultOps project configuration', 'bold'));
      console.log('');
      console.log('Commands:');
      console.log('  vaultops config show [enrich]          Show current config');
      console.log('  vaultops config set enrich.<role> <model>  Set model for a role');
      console.log('  vaultops config reset [enrich]         Reset to defaults (inherit)');
      console.log('');
      console.log('Roles:  ba, designer, sysanalyst, developer, qa');
      console.log('Models: inherit (use your current model), haiku, sonnet, opus');
      console.log('');
      console.log('Examples:');
      console.log('  vaultops config set enrich.ba haiku');
      console.log('  vaultops config set enrich.developer sonnet');
      console.log('  vaultops config show enrich');
      console.log('  vaultops config reset enrich');
  }
}

function cmdConfigShow(opts) {
  const section = opts._[1];
  const configPath = resolveProjectConfigPath(opts);
  const cfg = parseEnvFile(configPath);

  if (!section || section === 'enrich') {
    console.log('');
    console.log(color('Enrich role models', 'bold'));
    console.log(`  Config: ${configPath}`);
    console.log('');
    const rows = [
      ['Role', 'Model', 'Note'],
      ['----', '-----', '----'],
    ];
    for (const role of ENRICH_ROLES) {
      const key = `ENRICH_MODEL_${role.toUpperCase()}`;
      const val = cfg[key] || 'inherit';
      const note = val === 'inherit' ? '(current user model)' : '(custom)';
      const marker = val === 'inherit' ? color('◆', 'dim') : color('◇', 'cyan');
      rows.push([role, `${marker} ${val}`, note]);
    }
    for (const [role, model, note] of rows) {
      console.log(`  ${_strPad(role, 14)}${_strPad(model, 20)}${note}`);
    }
    console.log('');
    console.log(`  ${color('Tip:', 'dim')} vault config set enrich.ba haiku`);
    console.log(`  ${color('    ', 'dim')} (haiku is cheaper/faster but less detailed)`);
    console.log('');
  } else {
    fail(`Unknown section: ${section}. Available: enrich`);
  }
}

function cmdConfigSet(opts) {
  const keyArg = opts._[1];
  const valueArg = opts._[2];

  if (!keyArg || !valueArg) {
    fail('Usage: vault config set <key> <value>');
    console.log('  Example: vault config set enrich.ba haiku');
    process.exit(1);
  }

  const [section, roleKey] = keyArg.split('.');
  if (section !== 'enrich') {
    fail(`Unknown section: ${section}. Available: enrich`);
    process.exit(1);
  }
  if (!ENRICH_ROLES.includes(roleKey)) {
    fail(`Unknown role: ${roleKey}. Valid roles: ${ENRICH_ROLES.join(', ')}`);
    process.exit(1);
  }
  if (!VALID_MODELS.has(valueArg)) {
    fail(`Invalid model: ${valueArg}. Valid: ${[...VALID_MODELS].join(', ')}`);
    process.exit(1);
  }

  const envKey = `ENRICH_MODEL_${roleKey.toUpperCase()}`;
  const configPath = resolveProjectConfigPath(opts);
  writeEnvFile(configPath, { [envKey]: valueArg });

  const marker = valueArg === 'inherit' ? color('◆', 'dim') : color('◇', 'cyan');
  ok(`enrich.${roleKey} → ${marker} ${color(valueArg, 'bold')}`);
  if (valueArg !== 'inherit') {
    console.log(`  ${color('Note:', 'dim')} ${valueArg === 'haiku' ? 'faster and cheaper, but less detailed output' : 'custom model active'}`);
  }
}

function cmdConfigReset(opts) {
  const section = opts._[1];
  if (section && section !== 'enrich') {
    fail(`Unknown section: ${section}. Available: enrich`);
    process.exit(1);
  }

  const configPath = resolveProjectConfigPath(opts);
  const cfg = parseEnvFile(configPath);
  for (const role of ENRICH_ROLES) {
    delete cfg[`ENRICH_MODEL_${role.toUpperCase()}`];
  }

  ensureDir(path.dirname(configPath));
  const lines = Object.entries(cfg).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(configPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

  ok(`enrich role models reset to ${color('inherit', 'bold')} (current user model)`);
}


// ── Help & main ──────────────────────────────────────────────────────────

function printHelp() {
  console.log(color('VaultOps CLI — Claude Code Plugin for Obsidian-based task management', 'bold'));
  console.log('');
  console.log('Commands:');
  console.log('  vaultops install            Deploy global VaultOps CLI (install / update)');
  console.log('  vaultops update             New version pull — CLI, MCP server, and skills');
  console.log('  vaultops add [path]         Track a project: register and configure MCP + skills');
  console.log('  vaultops init [path]        Set up vault structure, MCP, and skills from scratch');
  console.log('  vaultops status [path]      Tell me about registered projects or a specific one');
  console.log('  vaultops open [path]        Explore Obsidian vault for this project');
  console.log('  vaultops config             Manage per-project config (e.g. enrich role models)');
  console.log('  vaultops dashboard          Aggregate view — interactive multi-project dashboard');
  console.log('  vaultops uninstall [path]   Leave cleanly — remove VaultOps (CLI + artifacts)');
  console.log('    --purge                   Also delete ~/.vaultops/ (requires --yes)');
  console.log('    --yes / -y                Skip confirmation for destructive ops');
  console.log('');
  console.log('After setup, use in Claude Code:');
  console.log(`  ${color('/vault:today', 'bold')}   — daily task checklist`);
  console.log(`  ${color('/vault:task', 'bold')}    — create/update tasks (EXE-### IDs)`);
  console.log(`  ${color('/vault:plan', 'bold')}    — write work plans`);
  console.log(`  ${color('/vault:kanban', 'bold')}  — Kanban board view`);
  console.log(`  ${color('/vault:docs', 'bold')}    — generate project documentation`);
  console.log('');
  console.log('Options:');
  console.log('  --vault-root <path>      Obsidian vault root (default: ~/.vaultops/vault)');
  console.log('  --repo-id <id>           Override repository ID');
  console.log('');
  console.log('Dashboard flags:');
  console.log('  --once                   Render one frame and exit');
  console.log('  --json                   Print machine-readable JSON snapshot');
  console.log('  --watch <sec>            Auto-refresh interval');
  console.log('  --api-health             Enable API health checks (disabled by default)');
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    printHelp();
    return;
  }

  // Support 'vault ps <cmd>' alias
  if (args[0] === 'ps') args.shift();

  const command = args.shift();
  const opts = parseOptions(args);
  if (opts.help) { printHelp(); return; }
  if (!command) { printHelp(); return; }

  switch (command) {
    case 'install': cmdInstall(opts); return;
    case 'add': cmdAdd(opts); return;
    case 'init': cmdInit(opts); return;
    case 'update': cmdUpdate(opts); return;
    case 'repo': cmdRepo(opts); return;
    case 'status': case 'list': cmdStatus(opts); return;
    case 'open': cmdOpen(opts); return;
    case 'dashboard': await cmdDashboard(opts); return;
    case 'uninstall': cmdUninstall(opts); return;
    case 'config': cmdConfig(opts); return;
    default: throw new Error(`Unknown command: ${command}. Run 'vaultops --help' for usage.`);
  }
}

main().catch((error) => {
  fail(error.message || String(error));
  process.exit(1);
});
