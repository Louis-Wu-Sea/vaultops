/**
 * Read .vaultops/config.env files.
 *
 * Ported from Python's config.env parsing scattered across
 * _resolve_vault_root() and _resolve_vault_project().
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ConfigEnv {
  vaultRoot?: string;
  vaultPath?: string;
  [key: string]: string | undefined;
}

/**
 * Parse a .vaultops/config.env file into key-value pairs.
 * Returns an empty object if the file doesn't exist.
 */
export function readConfigEnv(projectPath: string): ConfigEnv {
  const configPath = path.join(projectPath, ".vaultops", "config.env");

  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return {};
  }

  const result: ConfigEnv = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Map known keys to typed fields
    if (key === "VAULTOPS_PROJECT_VAULT_ROOT") {
      result.vaultRoot = value;
    } else if (key === "VAULTOPS_PROJECT_VAULT_PATH") {
      result.vaultPath = value;
    }

    result[key] = value;
  }

  return result;
}
