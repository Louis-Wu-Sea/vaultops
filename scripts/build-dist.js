#!/usr/bin/env node
/**
 * build-dist.js — stage the full dist/ tree for packaging (no obfuscation).
 *
 * Output:
 *   dist/
 *   ├── scripts/
 *   │   ├── vault_cli.js
 *   │   ├── vaultops_mcp_server.py
 *   │   ├── cli/dashboard/
 *   │   └── hooks/
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

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'build-dist.js') continue;
    if (entry.name === 'build-landing.sh') continue;
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
