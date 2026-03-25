'use strict';

const { spawnSync } = require('child_process');
const readline = require('readline');
const { collectDashboardSnapshot } = require('./collector');
const { renderDashboard } = require('./render');

function asBool(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value || '').toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'y' || text === 'on';
}

function asPositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function hasCommand(command) {
  const probe = spawnSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

function openPath(targetPath) {
  if (!targetPath) {
    return { ok: false, message: 'No path selected' };
  }

  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [targetPath];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', targetPath];
  } else {
    cmd = 'xdg-open';
    args = [targetPath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.status === 0) {
    return { ok: true, message: `Opened: ${targetPath}` };
  }
  return { ok: false, message: `Open failed. Path: ${targetPath}` };
}

function copyPathToClipboard(targetPath) {
  if (!targetPath) {
    return { ok: false, message: 'No path selected' };
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('pbcopy', { input: targetPath, encoding: 'utf8' });
    return result.status === 0
      ? { ok: true, message: 'Path copied to clipboard' }
      : { ok: false, message: `Copy failed. Path: ${targetPath}` };
  }

  if (process.platform === 'win32') {
    const result = spawnSync('clip', { input: targetPath, encoding: 'utf8' });
    return result.status === 0
      ? { ok: true, message: 'Path copied to clipboard' }
      : { ok: false, message: `Copy failed. Path: ${targetPath}` };
  }

  if (hasCommand('wl-copy')) {
    const result = spawnSync('wl-copy', { input: targetPath, encoding: 'utf8' });
    return result.status === 0
      ? { ok: true, message: 'Path copied to clipboard' }
      : { ok: false, message: `Copy failed. Path: ${targetPath}` };
  }

  if (hasCommand('xclip')) {
    const result = spawnSync('xclip', ['-selection', 'clipboard'], {
      input: targetPath,
      encoding: 'utf8',
    });
    return result.status === 0
      ? { ok: true, message: 'Path copied to clipboard' }
      : { ok: false, message: `Copy failed. Path: ${targetPath}` };
  }

  return { ok: false, message: `Clipboard tool missing. Path: ${targetPath}` };
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

async function buildSnapshot(runtime) {
  return collectDashboardSnapshot({
    registryPath: runtime.registryPath,
    path: runtime.path,
    includeApiHealth: runtime.includeApiHealth,
    healthTimeoutMs: runtime.healthTimeoutMs,
  });
}

async function runDashboard(opts, context) {
  const runtime = {
    registryPath: context.registryPath,
    path: opts.path || opts._[0] || context.path || null,
    once: asBool(opts.once),
    json: asBool(opts.json),
    watchSeconds: asPositiveNumber(opts.watch, 0),
  };

  const snapshot = await buildSnapshot(runtime);

  if (runtime.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  if (runtime.once || !process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(
      renderDashboard(snapshot, {
        selectedIndex: 0,
        focus: 'list',
        loading: false,
      }),
    );
    return;
  }

  await runInteractive(snapshot, runtime);
}

async function runInteractive(initialSnapshot, runtime) {
  const state = {
    snapshot: initialSnapshot,
    selectedIndex: 0,
    focus: 'list',
    message: '',
    loading: false,
  };

  let closed = false;
  let refreshing = false;
  let watchTimer = null;

  function selectedProject() {
    const projects = state.snapshot.projects || [];
    if (!projects.length) {
      return null;
    }
    state.selectedIndex = Math.min(Math.max(state.selectedIndex, 0), projects.length - 1);
    return projects[state.selectedIndex];
  }

  function draw() {
    if (closed) {
      return;
    }
    clearScreen();
    process.stdout.write(
      renderDashboard(state.snapshot, {
        selectedIndex: state.selectedIndex,
        focus: state.focus,
        message: state.message,
        loading: state.loading,
      }),
    );
  }

  async function refresh(message) {
    if (refreshing || closed) {
      return;
    }
    refreshing = true;
    state.loading = true;
    if (message) {
      state.message = message;
    }
    draw();

    try {
      state.snapshot = await buildSnapshot(runtime);
      const projects = state.snapshot.projects || [];
      state.selectedIndex = Math.min(Math.max(state.selectedIndex, 0), Math.max(0, projects.length - 1));
      state.loading = false;
      state.message = `Refreshed at ${new Date().toISOString().slice(11, 19)}Z`;
    } catch (error) {
      state.loading = false;
      state.message = `Refresh failed: ${error && error.message ? error.message : String(error)}`;
    } finally {
      refreshing = false;
      draw();
    }
  }

  function stop() {
    if (closed) {
      return;
    }
    closed = true;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    process.stdin.off('keypress', onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write('\n\x1b[?25h');
  }

  function onKeypress(_str, key) {
    if (!key) {
      return;
    }

    if (key.sequence === '\u0003' || key.name === 'q') {
      stop();
      return;
    }

    if (key.name === 'tab') {
      state.focus = state.focus === 'list' ? 'detail' : 'list';
      draw();
      return;
    }

    if (key.name === 'up' && state.focus === 'list') {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      draw();
      return;
    }

    if (key.name === 'down' && state.focus === 'list') {
      const max = Math.max(0, (state.snapshot.projects || []).length - 1);
      state.selectedIndex = Math.min(max, state.selectedIndex + 1);
      draw();
      return;
    }

    if (key.name === 'r') {
      refresh('Refreshing...');
      return;
    }

    if (key.name === 'o') {
      const project = selectedProject();
      const result = openPath(project ? project.path : '');
      state.message = result.message;
      draw();
      return;
    }

    if (key.name === 'c') {
      const project = selectedProject();
      const result = copyPathToClipboard(project ? project.path : '');
      state.message = result.message;
      draw();
    }
  }

  process.stdout.write('\x1b[?25l');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', onKeypress);

  if (runtime.watchSeconds > 0) {
    watchTimer = setInterval(() => {
      refresh();
    }, runtime.watchSeconds * 1000);
  }

  draw();

  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (closed) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
}

module.exports = {
  runDashboard,
};
