import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseFrontmatter, updateFrontmatterField, updateFrontmatterList, serializeFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns empty frontmatter for content without ---", () => {
    const result = parseFrontmatter("# Hello\nWorld");
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, "# Hello\nWorld");
  });

  it("returns empty frontmatter for malformed (no closing ---)", () => {
    const result = parseFrontmatter("---\ntitle: Hello\nNo closing");
    assert.deepStrictEqual(result.frontmatter, {});
  });

  it("parses simple string values", () => {
    const content = `---
title: My Task
status: TODO
---
Body text`;
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter.title, "My Task");
    assert.strictEqual(result.frontmatter.status, "TODO");
    assert.ok(result.body.includes("Body text"));
  });

  it("parses boolean values", () => {
    const content = `---
active: true
archived: false
---
`;
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter.active, true);
    assert.strictEqual(result.frontmatter.archived, false);
  });

  it("parses inline arrays", () => {
    const content = `---
tags: [tag1, tag2, tag3]
---
`;
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter.tags, ["tag1", "tag2", "tag3"]);
  });

  it("parses inline arrays with quoted values containing commas", () => {
    const content = `---
tags: [simple, "item, with comma", 'another, one']
---
`;
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter.tags, ["simple", "item, with comma", "another, one"]);
  });

  it("parses quoted string values", () => {
    const content = `---
title: "Hello World"
note: 'Single quoted'
---
`;
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter.title, "Hello World");
    assert.strictEqual(result.frontmatter.note, "Single quoted");
  });

  it("handles values with colons (splits on first : only)", () => {
    const content = `---
updated_at: 2024-01-15T10:30:00Z
url: https://example.com
---
`;
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter.updated_at, "2024-01-15T10:30:00Z");
    assert.strictEqual(result.frontmatter.url, "https://example.com");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
Body`;
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.ok(result.body.includes("Body"));
  });

  it("handles YAML list syntax (- item per line)", () => {
    const content = `---
tags:
  - alpha
  - beta
  - gamma
---
Body`;
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter.tags, ["alpha", "beta", "gamma"]);
  });

  it("handles empty string content", () => {
    const result = parseFrontmatter("");
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, "");
  });

  it("handles real VaultOps task frontmatter", () => {
    const content = `---
id: EXE-001
task: Implement auth module
status: IN_PROGRESS
priority: P1
owner: Agent
created: 2024-01-15
tags: [vaultops/task, auth, backend]
blocked_by: []
verify: [{type: file_exists, path: src/auth.ts}]
---

## Task Description
Implement the authentication module.
`;
    const result = parseFrontmatter(content);
    assert.strictEqual(result.frontmatter.id, "EXE-001");
    assert.strictEqual(result.frontmatter.status, "IN_PROGRESS");
    assert.deepStrictEqual(result.frontmatter.tags, ["vaultops/task", "auth", "backend"]);
    assert.ok(result.body.includes("## Task Description"));
  });
});

describe("updateFrontmatterField", () => {
  it("updates existing field", () => {
    const content = `---
status: TODO
---
Body`;
    const result = updateFrontmatterField(content, "status", "DONE");
    assert.ok(result.includes("status: DONE"));
    assert.ok(!result.includes("status: TODO"));
  });

  it("adds new field if not present", () => {
    const content = `---
title: Hello
---
Body`;
    const result = updateFrontmatterField(content, "status", "TODO");
    assert.ok(result.includes("status: TODO"));
    assert.ok(result.includes("title: Hello"));
  });

  it("returns content unchanged if no frontmatter", () => {
    const content = "# No frontmatter";
    assert.strictEqual(updateFrontmatterField(content, "status", "TODO"), content);
  });
});

describe("updateFrontmatterList", () => {
  it("adds value to existing array", () => {
    const content = `---
tags: [a, b]
---
Body`;
    const result = updateFrontmatterList(content, "tags", "c");
    const parsed = parseFrontmatter(result);
    assert.deepStrictEqual(parsed.frontmatter.tags, ["a", "b", "c"]);
  });

  it("does not add duplicate value", () => {
    const content = `---
tags: [a, b]
---
Body`;
    const result = updateFrontmatterList(content, "tags", "b");
    const parsed = parseFrontmatter(result);
    assert.deepStrictEqual(parsed.frontmatter.tags, ["a", "b"]);
  });

  it("creates new array field if not present", () => {
    const content = `---
title: Hello
---
Body`;
    const result = updateFrontmatterList(content, "tags", "new");
    assert.ok(result.includes("tags: [new]"));
  });
});

describe("serializeFrontmatter", () => {
  it("serializes string values", () => {
    const result = serializeFrontmatter({ title: "Hello", status: "TODO" });
    assert.ok(result.includes("---"));
    assert.ok(result.includes("title: Hello"));
    assert.ok(result.includes("status: TODO"));
  });

  it("serializes arrays", () => {
    const result = serializeFrontmatter({ tags: ["a", "b", "c"] });
    assert.ok(result.includes("tags: [a, b, c]"));
  });

  it("serializes booleans", () => {
    const result = serializeFrontmatter({ active: true, archived: false });
    assert.ok(result.includes("active: true"));
    assert.ok(result.includes("archived: false"));
  });
});
