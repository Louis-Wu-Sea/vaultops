/**
 * Shared type definitions for VaultOps MCP server.
 */

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Tool system ────────────────────────────────────────────────────────

export type ToolArgs = Record<string, unknown>;

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export type ToolHandler = (args: ToolArgs) => ToolResult;

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

// ── Task Board ─────────────────────────────────────────────────────────

export type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";

export interface TaskRow {
  id: string;
  task: string;
  status: TaskStatus;
  rawStatus: string;
  priority: string;
  owner: string;
  details: string;
  evidence: string;
}

// ── Frontmatter ────────────────────────────────────────────────────────

export type FrontmatterValue = string | boolean | string[];

export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedMarkdown {
  frontmatter: FrontmatterData;
  body: string;
}

// ── Vault & Registry ───────────────────────────────────────────────────

export interface ProjectEntry {
  path: string;
  vaultRoot: string;
  repoId: string;
  type?: string;
}

export interface RepoEntry {
  path: string;
  vaultRoot: string;
  repoId: string;
  remote?: string;
  autocommit?: string;
}

export interface Registry {
  projects: ProjectEntry[];
}

export interface RepoRegistry {
  repos: RepoEntry[];
}

// ── Stats ──────────────────────────────────────────────────────────────

export interface VaultStats {
  done: number;
  active: number;
  todo: number;
  blocked: number;
  total: number;
  docs: number;
}

// ── Role system ────────────────────────────────────────────────────────

export type RoleName = "BA" | "Designer" | "SystemAnalyst" | "Developer" | "QA";

// ── Sprint ─────────────────────────────────────────────────────────────

export interface SprintData {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  tasks: string[];
  goals?: string[];
}

// ── Meeting ────────────────────────────────────────────────────────────

export interface MeetingData {
  id: string;
  title: string;
  date: string;
  type?: string;
  attendees?: string[];
  series?: string;
}
