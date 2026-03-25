/**
 * File reading utilities — explicit errors, never silent.
 *
 * Replaces Python's _read_file() which returned "" for missing files.
 */

import * as fs from "node:fs";
import { FileNotFoundError } from "../errors.js";

/**
 * Read a file as UTF-8. Throws FileNotFoundError if missing.
 */
export function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileNotFoundError(filePath);
    }
    throw err;
  }
}

/**
 * Read a file as UTF-8, returning null if file doesn't exist.
 * Use this only when missing files are expected (opt-in null).
 */
export function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a directory.
 */
export function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
