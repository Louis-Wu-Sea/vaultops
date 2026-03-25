import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { normalizeStatus, parseTaskBoard, nextTaskId, serializeTaskRow, serializeTaskBoard } from "./markdown-table.js";

describe("normalizeStatus", () => {
  it("normalizes DONE variants", () => {
    assert.strictEqual(normalizeStatus("done"), "DONE");
    assert.strictEqual(normalizeStatus("completed"), "DONE");
    assert.strictEqual(normalizeStatus("complete"), "DONE");
    assert.strictEqual(normalizeStatus("  DONE  "), "DONE");
  });

  it("normalizes IN_PROGRESS variants", () => {
    assert.strictEqual(normalizeStatus("in_progress"), "IN_PROGRESS");
    assert.strictEqual(normalizeStatus("in progress"), "IN_PROGRESS");
    assert.strictEqual(normalizeStatus("running"), "IN_PROGRESS");
  });

  it("normalizes BLOCKED variants", () => {
    assert.strictEqual(normalizeStatus("blocked"), "BLOCKED");
    assert.strictEqual(normalizeStatus("failed"), "BLOCKED");
    assert.strictEqual(normalizeStatus("error"), "BLOCKED");
  });

  it("defaults to TODO for unknown statuses", () => {
    assert.strictEqual(normalizeStatus("todo"), "TODO");
    assert.strictEqual(normalizeStatus("queued"), "TODO");
    assert.strictEqual(normalizeStatus("open"), "TODO");
    assert.strictEqual(normalizeStatus(""), "TODO");
    assert.strictEqual(normalizeStatus("unknown"), "TODO");
  });
});

describe("parseTaskBoard", () => {
  const sampleBoard = `| ID | Task | Status | Priority | Owner | Details | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| EXE-001 | Build auth | IN_PROGRESS | P1 | Agent | OAuth setup | |
| EXE-002 | Write tests | TODO | P2 | Team | Unit + E2E | |
| EXE-003 | Deploy | DONE | P1 | CI | Production | deploy.log |`;

  it("parses standard task board", () => {
    const rows = parseTaskBoard(sampleBoard);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].id, "EXE-001");
    assert.strictEqual(rows[0].task, "Build auth");
    assert.strictEqual(rows[0].status, "IN_PROGRESS");
    assert.strictEqual(rows[0].priority, "P1");
    assert.strictEqual(rows[2].evidence, "deploy.log");
  });

  it("skips header and separator rows", () => {
    const rows = parseTaskBoard(sampleBoard);
    assert.ok(rows.every((r) => r.id !== "ID"));
    assert.ok(rows.every((r) => !r.id.startsWith("---")));
  });

  it("handles empty board", () => {
    const rows = parseTaskBoard("");
    assert.strictEqual(rows.length, 0);
  });

  it("handles board with only header", () => {
    const board = `| ID | Task | Status | Priority | Owner | Details | Evidence |
| --- | --- | --- | --- | --- | --- | --- |`;
    const rows = parseTaskBoard(board);
    assert.strictEqual(rows.length, 0);
  });

  it("handles rows with fewer columns", () => {
    const board = `| ID | Task | Status | Pri | Own |
| --- | --- | --- | --- | --- |`;
    // Less than 6 columns = skipped
    const rows = parseTaskBoard(board);
    assert.strictEqual(rows.length, 0);
  });

  it("normalizes statuses in parsed rows", () => {
    const board = `| ID | Task | Status | Priority | Owner | Details | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| EXE-001 | Task | completed | P1 | A | D | E |`;
    const rows = parseTaskBoard(board);
    assert.strictEqual(rows[0].status, "DONE");
    assert.strictEqual(rows[0].rawStatus, "completed");
  });
});

describe("nextTaskId", () => {
  it("returns EXE-001 for empty board", () => {
    assert.strictEqual(nextTaskId([]), "EXE-001");
  });

  it("increments from highest ID", () => {
    const rows = parseTaskBoard(`| ID | Task | Status | Priority | Owner | Details | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| EXE-001 | A | TODO | P1 | X | D | |
| EXE-042 | B | TODO | P1 | X | D | |
| EXE-003 | C | TODO | P1 | X | D | |`);
    assert.strictEqual(nextTaskId(rows), "EXE-043");
  });

  it("pads to 3 digits", () => {
    const rows = parseTaskBoard(`| ID | Task | Status | Priority | Owner | Details | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| EXE-001 | A | TODO | P1 | X | D | |`);
    assert.strictEqual(nextTaskId(rows), "EXE-002");
  });
});

describe("serializeTaskBoard", () => {
  it("round-trips through parse and serialize", () => {
    const original = `| ID | Task | Status | Priority | Owner | Details | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| EXE-001 | Build auth | IN_PROGRESS | P1 | Agent | OAuth setup |  |
`;
    const rows = parseTaskBoard(original);
    const serialized = serializeTaskBoard(rows);
    const reparsed = parseTaskBoard(serialized);

    assert.strictEqual(reparsed.length, rows.length);
    assert.strictEqual(reparsed[0].id, rows[0].id);
    assert.strictEqual(reparsed[0].task, rows[0].task);
    assert.strictEqual(reparsed[0].status, rows[0].status);
  });
});
