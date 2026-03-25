import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readFile, readFileOrNull, fileExists, isDirectory } from "./read.js";
import { FileNotFoundError } from "../errors.js";

const TMP_DIR = path.join(os.tmpdir(), "vaultops-test-read");

// Setup/cleanup
function setup() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function cleanup() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

describe("readFile", () => {
  afterEach(cleanup);

  it("reads existing file", () => {
    setup();
    const filePath = path.join(TMP_DIR, "test.md");
    fs.writeFileSync(filePath, "Hello, World!", "utf-8");
    assert.strictEqual(readFile(filePath), "Hello, World!");
  });

  it("throws FileNotFoundError for missing file", () => {
    assert.throws(
      () => readFile("/nonexistent/path/file.md"),
      (err: unknown) => err instanceof FileNotFoundError,
    );
  });

  it("reads UTF-8 content correctly", () => {
    setup();
    const filePath = path.join(TMP_DIR, "unicode.md");
    fs.writeFileSync(filePath, "Привет мир 🌍", "utf-8");
    assert.strictEqual(readFile(filePath), "Привет мир 🌍");
  });
});

describe("readFileOrNull", () => {
  afterEach(cleanup);

  it("reads existing file", () => {
    setup();
    const filePath = path.join(TMP_DIR, "test.md");
    fs.writeFileSync(filePath, "content", "utf-8");
    assert.strictEqual(readFileOrNull(filePath), "content");
  });

  it("returns null for missing file", () => {
    assert.strictEqual(readFileOrNull("/nonexistent/path/file.md"), null);
  });
});

describe("fileExists", () => {
  afterEach(cleanup);

  it("returns true for existing file", () => {
    setup();
    const filePath = path.join(TMP_DIR, "exists.md");
    fs.writeFileSync(filePath, "", "utf-8");
    assert.strictEqual(fileExists(filePath), true);
  });

  it("returns false for missing file", () => {
    assert.strictEqual(fileExists("/nonexistent/file.md"), false);
  });
});

describe("isDirectory", () => {
  afterEach(cleanup);

  it("returns true for directory", () => {
    setup();
    assert.strictEqual(isDirectory(TMP_DIR), true);
  });

  it("returns false for file", () => {
    setup();
    const filePath = path.join(TMP_DIR, "file.md");
    fs.writeFileSync(filePath, "", "utf-8");
    assert.strictEqual(isDirectory(filePath), false);
  });

  it("returns false for missing path", () => {
    assert.strictEqual(isDirectory("/nonexistent/dir"), false);
  });
});
