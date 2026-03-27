import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWrite, appendToFile } from "./write.js";

const TMP_DIR = path.join(os.tmpdir(), "vaultops-test-write");

function cleanup() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

describe("atomicWrite", () => {
  afterEach(cleanup);

  it("writes content to file", () => {
    const filePath = path.join(TMP_DIR, "test.md");
    atomicWrite(filePath, "Hello, World!");
    assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "Hello, World!");
  });

  it("creates parent directories", () => {
    const filePath = path.join(TMP_DIR, "deep", "nested", "file.md");
    atomicWrite(filePath, "content");
    assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "content");
  });

  it("overwrites existing file", () => {
    const filePath = path.join(TMP_DIR, "overwrite.md");
    atomicWrite(filePath, "original");
    atomicWrite(filePath, "updated");
    assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "updated");
  });

  it("handles UTF-8 content", () => {
    const filePath = path.join(TMP_DIR, "utf8.md");
    atomicWrite(filePath, "Привет 🌍");
    assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "Привет 🌍");
  });

  it("leaves no temp files on success", () => {
    const filePath = path.join(TMP_DIR, "clean.md");
    atomicWrite(filePath, "content");
    const files = fs.readdirSync(TMP_DIR);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], "clean.md");
  });
});

describe("appendToFile", () => {
  afterEach(cleanup);

  it("creates file if not exists", () => {
    const filePath = path.join(TMP_DIR, "new.md");
    appendToFile(filePath, "first line\n");
    assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "first line\n");
  });

  it("appends to existing file", () => {
    const filePath = path.join(TMP_DIR, "append.md");
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(filePath, "line1\n", "utf-8");
    appendToFile(filePath, "line2\n");
    assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "line1\nline2\n");
  });
});
