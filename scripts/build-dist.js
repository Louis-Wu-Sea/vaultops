#!/usr/bin/env node
/**
 * build-dist.js — stage the full dist/ tree for packaging (no obfuscation).
 *
 * Output:
 *   dist/
 *   ├── scripts/
 *   │   ├── vault_cli.js
 *   │   ├── compiled/        (TypeScript MCP server + hooks)
 *   │   └── cli/dashboard/
 *   └── skills/
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const COPY_DIRS = [
  'scripts',
  'skills',
];

// Skip Python files and build artifacts during copy
const SKIP_FILES = new Set(['build-dist.js', 'build-landing.sh']);
const SKIP_EXTENSIONS = new Set(['.py', '.pyc']);

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_FILES.has(entry.name)) continue;
    if (SKIP_EXTENSIONS.has(path.extname(entry.name))) continue;
    // Skip __pycache__ directories
    if (entry.name === '__pycache__') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

for (const dir of COPY_DIRS) {
  copyDir(path.join(ROOT, dir), path.join(DIST, dir));
  console.log(`  ✓  ${dir}/`);
}

console.log(`\nDist staged at: ${DIST}`);
