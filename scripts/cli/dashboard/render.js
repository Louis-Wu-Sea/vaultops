'use strict';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function color(text, tone, enabled) {
  if (!enabled || !tone || !ANSI[tone]) {
    return text;
  }
  return `${ANSI[tone]}${text}${ANSI.reset}`;
}

function fit(text, width) {
  if (width <= 0) {
    return '';
  }
  const value = String(text || '');
  if (value.length === width) {
    return value;
  }
  if (value.length < width) {
    return `${value}${' '.repeat(width - value.length)}`;
  }
  if (width === 1) {
    return '…';
  }
  return `${value.slice(0, width - 1)}…`;
}

function humanTime(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toISOString().replace('T', ' ').replace('Z', 'Z');
}

function formatListLines(projects, selectedIndex) {
  if (!projects.length) {
    return ['No projects found. Run `vaultops add` first.'];
  }

  return projects.map((project, index) => {
    const marker = index === selectedIndex ? '>' : ' ';
    const local = project.localStatus === 'ok' ? 'OK' : 'MISS';
    const stats = `D${project.taskStats.done}/I${project.taskStats.inProgress}/B${project.taskStats.blocked}/Q${project.taskStats.queued}`;
    return `${marker} ${project.repoId} [${local}] ${stats}`;
  });
}

function roleHintsToLines(roleHints) {
  const taskIds = Object.keys(roleHints || {});
  if (!taskIds.length) {
    return ['Role hints: -'];
  }

  const lines = ['Role hints:'];
  const sorted = taskIds.sort((a, b) => a.localeCompare(b)).slice(0, 4);
  for (const taskId of sorted) {
    const taskHints = roleHints[taskId] || {};
    const ba = taskHints.BA && taskHints.BA.status ? taskHints.BA.status : '-';
    const ds = taskHints.Designer && taskHints.Designer.status ? taskHints.Designer.status : '-';
    const dv = taskHints.Developer && taskHints.Developer.status ? taskHints.Developer.status : '-';
    const qa = taskHints.QA && taskHints.QA.status ? taskHints.QA.status : '-';
    lines.push(`- ${taskId}: BA=${ba}, D=${ds}, Dev=${dv}, QA=${qa}`);
  }
  return lines;
}

function formatDetailLines(project) {
  if (!project) {
    return ['No repository selected.'];
  }

  const lines = [
    `Repo: ${project.repoId}`,
    `Path: ${project.path || '-'}`,
    `Docs root: ${project.docsRoot || '-'}`,
    `Workspace: ${project.workspaceId || '-'}`,
    `Policy: ${project.policyPack || '-'}`,
    `Last init: ${humanTime(project.lastInitAt)}`,
    `Last activity: ${humanTime(project.lastActivityAt)}`,
    `Current stage: ${project.currentStage || '-'}`,
    `Tasks: total=${project.taskStats.total}, done=${project.taskStats.done}, in_progress=${project.taskStats.inProgress}, blocked=${project.taskStats.blocked}, queued=${project.taskStats.queued}`,
  ];

  return lines.concat(roleHintsToLines(project.roleHints));
}

function applyStatusColors(line, colorsEnabled) {
  if (!colorsEnabled) {
    return line;
  }

  return line
    .replace(/\bOK\b/g, color('OK', 'green', colorsEnabled))
    .replace(/\bMISS\b/g, color('MISS', 'red', colorsEnabled))
    .replace(/\bhealthy\b/g, color('healthy', 'green', colorsEnabled))
    .replace(/\bdegraded\b/g, color('degraded', 'yellow', colorsEnabled))
    .replace(/\bdone\b/g, color('done', 'green', colorsEnabled))
    .replace(/\bin_progress\b/g, color('in_progress', 'cyan', colorsEnabled))
    .replace(/\bblocked\b/g, color('blocked', 'red', colorsEnabled))
    .replace(/\bqueued\b/g, color('queued', 'yellow', colorsEnabled));
}

function renderDashboard(snapshot, state = {}, options = {}) {
  const projects = Array.isArray(snapshot && snapshot.projects) ? snapshot.projects : [];
  const global = snapshot && snapshot.global ? snapshot.global : {
    generatedAt: new Date().toISOString(),
    reposTotal: 0,
    reposHealthy: 0,
    tasksTotal: 0,
    tasksDone: 0,
    tasksInProgress: 0,
    tasksBlocked: 0,
    tasksQueued: 0,
  };

  const selectedIndex = Number.isInteger(state.selectedIndex)
    ? Math.min(Math.max(state.selectedIndex, 0), Math.max(0, projects.length - 1))
    : 0;
  const selectedProject = projects[selectedIndex] || null;

  const width = Math.max(100, Math.min(process.stdout.columns || 120, 180));
  const totalInner = width - 2;
  const splitGap = 1;
  const leftWidth = Math.max(34, Math.floor((totalInner - splitGap) * 0.4));
  const rightWidth = totalInner - splitGap - leftWidth;

  const bodyRows = Math.max(12, Math.min((process.stdout.rows || 34) - 10, 20));
  const colorsEnabled = options.colors !== false && process.stdout.isTTY && process.env.NO_COLOR !== '1';
  const title = 'VaultOps Dashboard v1';

  const leftLines = formatListLines(projects, selectedIndex);
  const rightLines = formatDetailLines(selectedProject);

  const lines = [];
  lines.push(`┌${'─'.repeat(totalInner)}┐`);
  lines.push(`│${fit(title, totalInner)}│`);
  lines.push(`│${fit(`Generated: ${humanTime(global.generatedAt)} | Repos: ${global.reposHealthy}/${global.reposTotal} healthy`, totalInner)}│`);
  lines.push(`│${fit(`Tasks: total=${global.tasksTotal}, done=${global.tasksDone}, in_progress=${global.tasksInProgress}, blocked=${global.tasksBlocked}, queued=${global.tasksQueued}`, totalInner)}│`);
  lines.push(`├${'─'.repeat(leftWidth)}┬${'─'.repeat(rightWidth)}┤`);
  lines.push(`│${fit(`Repositories (${projects.length})`, leftWidth)}│${fit(`Details${state.focus ? ` [focus:${state.focus}]` : ''}`, rightWidth)}│`);
  lines.push(`├${'─'.repeat(leftWidth)}┼${'─'.repeat(rightWidth)}┤`);

  for (let i = 0; i < bodyRows; i += 1) {
    const left = fit(leftLines[i] || '', leftWidth);
    const right = fit(rightLines[i] || '', rightWidth);
    lines.push(`│${left}│${right}│`);
  }

  lines.push(`└${'─'.repeat(leftWidth)}┴${'─'.repeat(rightWidth)}┘`);

  const help = 'Keys: ↑/↓ select repo | Tab focus | r refresh | o open folder | c copy path | q quit';
  lines.push(fit(help, width));
  if (state.loading) {
    lines.push(fit(color('Refreshing snapshot...', 'dim', colorsEnabled), width));
  } else if (state.message) {
    lines.push(fit(state.message, width));
  }

  return lines.map((line) => applyStatusColors(line, colorsEnabled)).join('\n');
}

module.exports = {
  renderDashboard,
};
