/**
 * Unified vault path resolution.
 *
 * Replaces Python's 3 overlapping functions:
 * - _resolve_vault_root() (line 331)
 * - _resolve_vault_project() (line 358)
 * - _resolve_vault_project_from_registry() (line 386)
 * - _exec_path() (line 403)
 *
 * Now a single clear resolution chain with explicit errors.
 */

import * as path from "node:path";
import * as os from "node:os";
import { readConfigEnv } from "./config.js";
import { loadProjects } from "./registry.js";
import { isDirectory } from "../fs/read.js";
import { EXEC_DIR } from "../constants.js";
import { VaultNotFoundError, ExecDirNotFoundError } from "../errors.js";
import type { ProjectEntry } from "../types.js";

/**
 * Expand ~ to home directory and normalize path.
 */
function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Resolve the vault root directory for a project.
 *
 * Resolution order:
 * 1. VAULTOPS_PROJECT_VAULT_ROOT in .vaultops/config.env
 * 2. vaultRoot from projects.json registry
 *
 * Returns null if not found (does not throw).
 */
export function resolveVaultRoot(projectPath: string): string | null {
  const resolved = expandPath(projectPath);

  // 1. Check project-local config.env
  const config = readConfigEnv(resolved);
  if (config.vaultRoot) {
    return expandPath(config.vaultRoot);
  }

  // 2. Check registry
  const projects = loadProjects();
  const entry = projects.find((p) => p.path === resolved);
  if (entry?.vaultRoot) {
    return expandPath(entry.vaultRoot);
  }

  return null;
}

/**
 * Resolve the full vault project path (the directory containing 08-Execution/ etc).
 *
 * Resolution order:
 * 1. VAULTOPS_PROJECT_VAULT_PATH in .vaultops/config.env (direct path, no suffix)
 * 2. vault_root + repo_id (computed from project directory name)
 *
 * Returns null if not found (does not throw).
 */
export function resolveVaultProject(projectPath: string): string | null {
  const resolved = expandPath(projectPath);

  // 1. Direct override in config.env
  const config = readConfigEnv(resolved);
  if (config.vaultPath) {
    return expandPath(config.vaultPath);
  }

  // 2. vault_root + repo_id
  const vaultRoot = resolveVaultRoot(resolved);
  if (!vaultRoot) {
    return null;
  }

  const repoId = path.basename(path.resolve(resolved));
  return path.join(vaultRoot, repoId);
}

/**
 * Resolve vault project from a registry entry.
 * Respects config.env override. Falls back to vaultRoot + repoId from entry.
 */
export function resolveVaultProjectFromEntry(entry: ProjectEntry): string {
  if (entry.path) {
    const resolved = resolveVaultProject(entry.path);
    if (resolved) return resolved;
  }

  return path.join(expandPath(entry.vaultRoot), entry.repoId);
}

/**
 * Resolve the execution directory path (08-Execution/).
 *
 * Returns the path or throws VaultNotFoundError / ExecDirNotFoundError.
 */
export function resolveExecPath(projectPath: string): string {
  const vaultProject = resolveVaultProject(projectPath);
  if (!vaultProject) {
    throw new VaultNotFoundError(projectPath);
  }

  const execDir = path.join(vaultProject, EXEC_DIR);
  if (!isDirectory(execDir)) {
    throw new ExecDirNotFoundError(execDir);
  }

  return execDir;
}

/**
 * Resolve the execution directory, returning [path, null] or [null, errorMessage].
 * Compatibility wrapper for tools that expect the old tuple return pattern.
 */
export function execPath(projectPath: string): [string, null] | [null, string] {
  try {
    const dir = resolveExecPath(projectPath);
    return [dir, null];
  } catch (err: unknown) {
    if (err instanceof Error) {
      return [null, err.message];
    }
    return [null, String(err)];
  }
}

/**
 * Resolve the shared meetings root directory.
 *
 * Unlike Python (which incorrectly used projects[0]), meetings are cross-project
 * and stored in a shared location under the first project's vault root.
 */
export function resolveMeetingsRoot(): string | null {
  const projects = loadProjects();
  if (projects.length === 0) return null;

  // Use the first project's vault root for meetings (cross-project shared)
  const entry = projects[0];
  const vaultProject = resolveVaultProjectFromEntry(entry);
  const vaultRoot = path.dirname(vaultProject);
  return path.join(vaultRoot, "_meetings");
}
