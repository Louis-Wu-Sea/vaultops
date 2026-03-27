/**
 * VaultOps error hierarchy — explicit errors, never silent.
 */

export class VaultOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultOpsError";
  }
}

export class FileNotFoundError extends VaultOpsError {
  public readonly filePath: string;

  constructor(filePath: string) {
    super(`File not found: ${filePath}`);
    this.name = "FileNotFoundError";
    this.filePath = filePath;
  }
}

export class ParseError extends VaultOpsError {
  public readonly filePath?: string;

  constructor(message: string, filePath?: string) {
    super(filePath ? `${message} (file: ${filePath})` : message);
    this.name = "ParseError";
    this.filePath = filePath;
  }
}

export class RegistryError extends VaultOpsError {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export class VaultNotFoundError extends VaultOpsError {
  public readonly projectPath: string;

  constructor(projectPath: string) {
    super(`No vault root found for project: ${projectPath}. Run 'vaultops add' first.`);
    this.name = "VaultNotFoundError";
    this.projectPath = projectPath;
  }
}

export class ExecDirNotFoundError extends VaultOpsError {
  public readonly execDir: string;

  constructor(execDir: string) {
    super(`Execution directory not found: ${execDir}. Run 'vaultops init' first.`);
    this.name = "ExecDirNotFoundError";
    this.execDir = execDir;
  }
}
