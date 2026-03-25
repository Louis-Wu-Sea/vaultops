'use strict';

const fs = require('fs');
const path = require('path');

const ROLE_NAMES = ['BA', 'Designer', 'Developer', 'QA'];

function normalizeTaskStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return 'queued';
  }
  if (raw === 'done' || raw === 'completed' || raw === 'complete') {
    return 'done';
  }
  if (raw === 'in_progress' || raw === 'in progress' || raw === 'running') {
    return 'in_progress';
  }
  if (raw === 'blocked' || raw === 'failed' || raw === 'error') {
    return 'blocked';
  }
  return 'queued';
}

function parseTaskBoardMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line.startsWith('|')) {
      continue;
    }

    const body = line.endsWith('|') ? line.slice(1, -1) : line.slice(1);
    const cells = body.split('|').map((cell) => cell.trim());
    if (cells.length < 6) {
      continue;
    }

    const firstCell = cells[0].toLowerCase();
    if (firstCell === 'id') {
      continue;
    }

    const separatorLike = cells.every((cell) => /^:?-{2,}:?$/.test(cell));
    if (separatorLike) {
      continue;
    }

    const [id, task, rawStatus, priority, owner, ...notesParts] = cells;
    rows.push({
      id,
      task,
      rawStatus,
      status: normalizeTaskStatus(rawStatus),
      priority,
      owner,
      notes: notesParts.join(' | '),
    });
  }

  const stats = {
    total: rows.length,
    done: 0,
    inProgress: 0,
    blocked: 0,
    queued: 0,
  };

  for (const row of rows) {
    if (row.status === 'done') {
      stats.done += 1;
      continue;
    }
    if (row.status === 'in_progress') {
      stats.inProgress += 1;
      continue;
    }
    if (row.status === 'blocked') {
      stats.blocked += 1;
      continue;
    }
    stats.queued += 1;
  }

  return {
    rows,
    stats,
  };
}

function parseExecutionJournalLastActivity(markdown) {
  const isoRegex = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
  let latest = null;
  let match = null;
  const source = String(markdown || '');

  while ((match = isoRegex.exec(source)) !== null) {
    const candidate = new Date(match[0]);
    if (Number.isNaN(candidate.getTime())) {
      continue;
    }
    if (!latest || candidate.getTime() > latest.getTime()) {
      latest = candidate;
    }
  }

  return latest ? latest.toISOString() : null;
}

function parseCurrentStageMarkdown(markdown) {
  const lines = String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (!lines.length) {
    return '-';
  }

  const last = lines[lines.length - 1];
  return last.replace(/^-\s*/, '').trim() || '-';
}

function parseRoleOutputMarkdown(markdown) {
  const output = {
    run: null,
    status: null,
    updated: null,
  };

  const lines = String(markdown || '').split(/\r?\n/).map((line) => line.trim());
  for (const line of lines) {
    if (line.startsWith('- Run:')) {
      output.run = line.replace('- Run:', '').trim() || null;
      continue;
    }
    if (line.startsWith('- Status:')) {
      output.status = line.replace('- Status:', '').trim() || null;
      continue;
    }
    if (line.startsWith('- Updated:')) {
      const raw = line.replace('- Updated:', '').trim();
      const parsed = new Date(raw);
      output.updated = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
  }

  return output;
}

function parseRoleOutputsDir(roleOutputsDir, options = {}) {
  const taskIdSet = Array.isArray(options.taskIds) && options.taskIds.length
    ? new Set(options.taskIds)
    : null;
  const result = {};

  if (!roleOutputsDir || !fs.existsSync(roleOutputsDir)) {
    return result;
  }

  let taskDirs = [];
  try {
    taskDirs = fs.readdirSync(roleOutputsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return result;
  }

  for (const taskDir of taskDirs) {
    const taskId = taskDir.name;
    if (taskIdSet && !taskIdSet.has(taskId)) {
      continue;
    }

    const taskPath = path.join(roleOutputsDir, taskId);
    let files = [];
    try {
      files = fs.readdirSync(taskPath, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const role = file.name.replace(/\.md$/i, '');
      if (!ROLE_NAMES.includes(role)) {
        continue;
      }

      const filePath = path.join(taskPath, file.name);
      let markdown = '';
      try {
        markdown = fs.readFileSync(filePath, 'utf8');
      } catch {
        markdown = '';
      }

      if (!result[taskId]) {
        result[taskId] = {};
      }
      result[taskId][role] = parseRoleOutputMarkdown(markdown);
    }
  }

  return result;
}

module.exports = {
  normalizeTaskStatus,
  parseTaskBoardMarkdown,
  parseExecutionJournalLastActivity,
  parseCurrentStageMarkdown,
  parseRoleOutputMarkdown,
  parseRoleOutputsDir,
};
