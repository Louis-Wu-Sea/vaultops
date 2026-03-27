/**
 * Project and repo registry with mtime-based caching.
 *
 * Replaces Python's uncached registry reads (lines 2120-2156).
 * Now caches parsed results and only re-reads when file mtime changes.
 */

import * as fs from "node:fs";
import { PROJECTS_JSON, REPOS_JSON } from "../constants.js";
import type { ProjectEntry, Registry, RepoEntry, RepoRegistry } from "../types.js";

// ── Mtime-based cache ──────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  mtimeMs: number;
}

let projectsCache: CacheEntry<ProjectEntry[]> | null = null;
let reposCache: CacheEntry<RepoEntry[]> | null = null;

function readJsonCached<T>(filePath: string, cache: CacheEntry<T> | null, parser: (raw: string) => T): { data: T; cache: CacheEntry<T> } {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // File doesn't exist — return empty
    const empty = parser("{}");
    return { data: empty, cache: { data: empty, mtimeMs: 0 } };
  }

  // Cache hit — file hasn't changed
  if (cache && cache.mtimeMs === mtimeMs) {
    return { data: cache.data, cache };
  }

  // Cache miss — read and parse
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = parser(raw);
    const newCache = { data, mtimeMs };
    return { data, cache: newCache };
  } catch {
    const empty = parser("{}");
    return { data: empty, cache: { data: empty, mtimeMs: 0 } };
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Load all registered projects from projects.json.
 * Results are cached and only re-read when file changes.
 */
export function loadProjects(): ProjectEntry[] {
  const result = readJsonCached(PROJECTS_JSON, projectsCache, (raw) => {
    const parsed: Registry = JSON.parse(raw);
    return parsed.projects ?? [];
  });
  projectsCache = result.cache;
  return result.data;
}

/**
 * Load all registered doc repos from repos.json.
 * Results are cached and only re-read when file changes.
 */
export function loadRepos(): RepoEntry[] {
  const result = readJsonCached(REPOS_JSON, reposCache, (raw) => {
    const parsed: RepoRegistry = JSON.parse(raw);
    return parsed.repos ?? [];
  });
  reposCache = result.cache;
  return result.data;
}

/**
 * Load all projects + repos merged as a unified list.
 * Repos are converted to ProjectEntry format for cross-project tools.
 */
export function loadAllProjects(): ProjectEntry[] {
  const projects = loadProjects();
  const repos = loadRepos();

  const repoAsProjects: ProjectEntry[] = repos.map((r) => ({
    path: r.path,
    vaultRoot: r.vaultRoot,
    repoId: r.repoId,
    type: "doc-repo",
  }));

  return [...projects, ...repoAsProjects];
}

/**
 * Find a project entry by path.
 */
export function findProject(projectPath: string): ProjectEntry | undefined {
  return loadProjects().find((p) => p.path === projectPath);
}

/**
 * Invalidate all caches. Useful for testing.
 */
export function clearRegistryCache(): void {
  projectsCache = null;
  reposCache = null;
}
