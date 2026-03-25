import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readConfigEnv } from "./config.js";

const TMP_DIR = path.join(os.tmpdir(), "vaultops-test-config");

function cleanup() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

describe("readConfigEnv", () => {
  afterEach(cleanup);

  it("returns empty object if config.env missing", () => {
    const result = readConfigEnv("/nonexistent/project");
    assert.deepStrictEqual(result, {});
  });

  it("parses vault root", () => {
    const projectDir = path.join(TMP_DIR, "project");
    const configDir = path.join(projectDir, ".vaultops");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.env"),
      'VAULTOPS_PROJECT_VAULT_ROOT="/Users/test/vault"\n',
    );

    const result = readConfigEnv(projectDir);
    assert.strictEqual(result.vaultRoot, "/Users/test/vault");
  });

  it("parses vault path", () => {
    const projectDir = path.join(TMP_DIR, "project2");
    const configDir = path.join(projectDir, ".vaultops");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.env"),
      "VAULTOPS_PROJECT_VAULT_PATH=/Users/test/vault/project\n",
    );

    const result = readConfigEnv(projectDir);
    assert.strictEqual(result.vaultPath, "/Users/test/vault/project");
  });

  it("strips quotes from values", () => {
    const projectDir = path.join(TMP_DIR, "project3");
    const configDir = path.join(projectDir, ".vaultops");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.env"),
      `VAULTOPS_PROJECT_VAULT_ROOT="/path/double"\nVAULTOPS_PROJECT_VAULT_PATH='/path/single'\n`,
    );

    const result = readConfigEnv(projectDir);
    assert.strictEqual(result.vaultRoot, "/path/double");
    assert.strictEqual(result.vaultPath, "/path/single");
  });

  it("ignores comments and empty lines", () => {
    const projectDir = path.join(TMP_DIR, "project4");
    const configDir = path.join(projectDir, ".vaultops");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.env"),
      "# This is a comment\n\nVAULTOPS_PROJECT_VAULT_ROOT=/vault\n",
    );

    const result = readConfigEnv(projectDir);
    assert.strictEqual(result.vaultRoot, "/vault");
    assert.strictEqual(result["# This is a comment"], undefined);
  });
});
