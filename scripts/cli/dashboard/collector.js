'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseTaskBoardMarkdown,
  parseExecutionJournalLastActivity,
  parseCurrentStageMarkdown,
  parseRoleOutputsDir,
} = require('./parsers');

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readTextSafe(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function parseEnvFile(filePath) {
  const output = {};
  if (!fs.existsSync(filePath)) {
    return output;
  }
  const content = readTextSafe(filePath, '');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    output[key] = value;
  }
  return output;
}

function toResolvedPath(value) {
  if (!value) {
    return '';
  }
  return path.resolve(String(value));
}


function defaultTaskStats() {
  return {
    total: 0,
    done: 0,
    inProgress: 0,
    blocked: 0,
    queued: 0,
  };
}

function asProjectArray(registry) {
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.projects)) {
    return [];
  }
  return registry.projects;
}

async function collectProjectSnapshot(entry, options) {
  const projectPath = toResolvedPath(entry.path);
  const repoExists = fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory();
  const localConfig = parseEnvFile(path.join(projectPath, '.vaultops', 'config.env'));
  const docsRoot = localConfig.VAULTOPS_PROJECT_VAULT_ROOT
    ? toResolvedPath(localConfig.VAULTOPS_PROJECT_VAULT_ROOT)
    : projectPath;
  const docsExists = fs.existsSync(docsRoot) && fs.statSync(docsRoot).isDirectory();
  const localStatus = repoExists && docsExists ? 'ok' : 'missing';

  const snapshot = {
    repoId: String(entry.repoId || 'unknown_repo'),
    path: projectPath,
    docsRoot,
    workspaceId: String(entry.workspaceId || ''),
    policyPack: String(entry.policyPack || ''),
    lastInitAt: entry.lastInitAt || null,
    localStatus,
    taskStats: defaultTaskStats(),
    lastActivityAt: null,
    currentStage: '-',
    roleHints: {},
  };

  if (repoExists && docsExists) {
    const executionDir = path.join(docsRoot, '08-Execution');
    const taskBoardPath = path.join(executionDir, 'Task Board.md');
    const journalPath = path.join(executionDir, 'Execution Journal.md');
    const currentStagePath = path.join(executionDir, 'Current Stage.md');
    const roleOutputsPath = path.join(executionDir, 'Role Outputs');

    const taskBoard = parseTaskBoardMarkdown(readTextSafe(taskBoardPath, ''));
    snapshot.taskStats = taskBoard.stats;
    snapshot.lastActivityAt = parseExecutionJournalLastActivity(readTextSafe(journalPath, ''));
    snapshot.currentStage = parseCurrentStageMarkdown(readTextSafe(currentStagePath, ''));
    snapshot.roleHints = parseRoleOutputsDir(roleOutputsPath, {
      taskIds: taskBoard.rows.map((row) => row.id),
    });
  } else {
    snapshot.currentStage = !repoExists
      ? 'Local repo path is missing'
      : 'Project docs root is missing';
  }

  return snapshot;
}

function buildGlobalSnapshot(projects) {
  const global = {
    generatedAt: new Date().toISOString(),
    reposTotal: projects.length,
    reposHealthy: 0,
    tasksTotal: 0,
    tasksDone: 0,
    tasksInProgress: 0,
    tasksBlocked: 0,
    tasksQueued: 0,
  };

  for (const project of projects) {
    if (project.localStatus === 'ok') {
      global.reposHealthy += 1;
    }

    global.tasksTotal += project.taskStats.total;
    global.tasksDone += project.taskStats.done;
    global.tasksInProgress += project.taskStats.inProgress;
    global.tasksBlocked += project.taskStats.blocked;
    global.tasksQueued += project.taskStats.queued;
  }

  return global;
}

async function collectDashboardSnapshot(options = {}) {
  const registryPath = options.registryPath || '';
  const registry = readJsonSafe(registryPath, { version: 1, projects: [] });
  const filterPath = options.path ? toResolvedPath(options.path) : '';
  const projects = asProjectArray(registry)
    .filter((entry) => !filterPath || toResolvedPath(entry.path) === filterPath);

  const projectSnapshots = await Promise.all(
    projects.map((entry) =>
      collectProjectSnapshot(entry, {
        includeApiHealth: options.includeApiHealth !== false,
        healthTimeoutMs: options.healthTimeoutMs || 800,
      }),
    ),
  );

  return {
    global: buildGlobalSnapshot(projectSnapshots),
    projects: projectSnapshots,
  };
}

module.exports = {
  collectDashboardSnapshot,
  collectProjectSnapshot,
  buildGlobalSnapshot,
};
