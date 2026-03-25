/**
 * Tool registry — all 43 tool definitions + handler dispatch.
 *
 * Ported from Python _tools_list_result() (lines 4953-5539) and
 * _handle_tools_call() (lines 4888-4950).
 */

import type { ToolArgs, ToolDefinition, ToolHandler, ToolResult } from "../types.js";
import { toolResult } from "./helpers.js";

// ── Handler imports ──────────────────────────────────────────────────────

import { getContext, getToday, updateTask, createTask, logStep, writePlan, getKanban, generateDocsPrompt } from "./core.js";
import { getTask, writeRoleOutput, getRoleOutput } from "./roles.js";
import { linkTasks, getTaskGraph } from "./relationships.js";
import { getVelocity, getBurndown } from "./metrics.js";
import { searchTasks, createCrossProjectLink, getCrossProjectDeps } from "./cross-project.js";
import { scheduleTask, getSchedule, createSprint, assignToSprint, getSprint } from "./sprint.js";
import { generateCanvas, generateRetro } from "./visual.js";
import { learnFromHistory, getInsights, adaptPriority, getLearningStatus } from "./learning.js";
import { runVerify } from "./verify.js";
import { getPredictions } from "./predictive.js";
import { getProjectDna } from "./adaptive.js";
import { getReplay, getStaleDocs, getArchRadar, generateReport } from "./ecosystem.js";
import { createMeeting, getMeeting, dispatchActionItems, linkDecisionToAdr, createFollowup, getMeetingDashboard, getMeetingSeries } from "./meetings.js";

// ── Handler dispatch map ─────────────────────────────────────────────────

const handlers: Record<string, ToolHandler> = {
  get_context: getContext,
  get_today: getToday,
  update_task: updateTask,
  create_task: createTask,
  log_step: logStep,
  write_plan: writePlan,
  get_kanban: getKanban,
  generate_docs_prompt: generateDocsPrompt,
  get_task: getTask,
  write_role_output: writeRoleOutput,
  get_role_output: getRoleOutput,
  link_tasks: linkTasks,
  get_task_graph: getTaskGraph,
  get_velocity: getVelocity,
  get_burndown: getBurndown,
  search_tasks: searchTasks,
  create_cross_project_link: createCrossProjectLink,
  get_cross_project_deps: getCrossProjectDeps,
  schedule_task: scheduleTask,
  get_schedule: getSchedule,
  create_sprint: createSprint,
  assign_to_sprint: assignToSprint,
  get_sprint: getSprint,
  generate_canvas: generateCanvas,
  generate_retro: generateRetro,
  learn_from_history: learnFromHistory,
  get_insights: getInsights,
  adapt_priority: adaptPriority,
  get_learning_status: getLearningStatus,
  run_verify: runVerify,
  get_predictions: getPredictions,
  get_project_dna: getProjectDna,
  get_replay: getReplay,
  get_stale_docs: getStaleDocs,
  get_arch_radar: getArchRadar,
  generate_report: generateReport,
  create_meeting: createMeeting,
  get_meeting: getMeeting,
  dispatch_action_items: dispatchActionItems,
  link_decision_to_adr: linkDecisionToAdr,
  create_followup: createFollowup,
  get_meeting_dashboard: getMeetingDashboard,
  get_meeting_series: getMeetingSeries,
};

// ── Shared schema fragments ──────────────────────────────────────────────

const pp = {
  type: "string" as const,
  description: "Absolute path to the project root directory.",
};

// ── Tool definitions (inputSchema for each tool) ─────────────────────────

const toolDefinitions: ToolDefinition[] = [
  // ── Core (8) ────────────────────────────────────────────────
  {
    name: "get_context",
    description: "Get structured project context: current stage, context state, and task summary from Obsidian vault.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },
  {
    name: "get_today",
    description: "Get today's active tasks (IN_PROGRESS, BLOCKED, TODO) as a checklist from Obsidian Task Board.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },
  {
    name: "update_task",
    description: "Update an existing task's status and/or evidence in the Obsidian Task Board.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID (e.g. EXE-001)" },
        status: { type: "string", description: "New status: TODO, IN_PROGRESS, DONE, BLOCKED" },
        evidence: { type: "string", description: "Evidence text to append (test results, file changes)" },
      },
      required: ["project_path", "task_id"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task with auto-incremented EXE-### ID. Creates both a Task Board row and an individual task file with YAML frontmatter. Supports Task-as-Code verify checks — completion contracts that must pass before auto-complete.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description/details" },
        priority: { type: "string", description: "Priority: P1, P2, P3 (default: P1)" },
        owner: { type: "string", description: "Task owner (default: Agent)" },
        scheduled_date: { type: "string", description: "Scheduled date YYYY-MM-DD for day planning" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        blocked_by: { type: "array", items: { type: "string" }, description: "Task IDs this is blocked by" },
        parent_task: { type: "string", description: "Parent task ID for sub-tasks (creates EXE-001.1 format)" },
        verify: {
          type: "array",
          description: "Task-as-Code completion contract. List of checks that must pass for auto-complete. Types: file_exists (path), file_changed (path), grep_content (path + pattern), test_pattern (pattern).",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["file_exists", "file_changed", "grep_content", "test_pattern"] },
              path: { type: "string", description: "File path (relative to project root)" },
              pattern: { type: "string", description: "Regex pattern for grep_content or glob for test_pattern" },
              expect: { type: "string", description: "Expected result: pass/fail (default: pass)" },
            },
            required: ["type"],
          },
        },
      },
      required: ["project_path", "title"],
    },
  },
  {
    name: "log_step",
    description: "Append a timestamped entry to the Obsidian Execution Journal.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        message: { type: "string", description: "Log message describing what was done" },
      },
      required: ["project_path", "message"],
    },
  },
  {
    name: "write_plan",
    description: "Append a work plan to the Obsidian Work Plans file.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        content: { type: "string", description: "Plan content in markdown" },
      },
      required: ["project_path", "content"],
    },
  },
  {
    name: "get_kanban",
    description: "Get tasks grouped by status as a Kanban board view.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },
  {
    name: "generate_docs_prompt",
    description: "Scan repo and vault, return an AI prompt to generate project documentation for empty sections.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },

  // ── Roles (3) ───────────────────────────────────────────────
  {
    name: "get_task",
    description: "Get a single task by ID with full details, role outputs, and enrichment status. Shows which roles have completed their output and which is next.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID (e.g. EXE-001)" },
      },
      required: ["project_path", "task_id"],
    },
  },
  {
    name: "write_role_output",
    description: "Write a role-based enrichment output for a task. Roles: BA, Designer, SystemAnalyst, Developer, QA. Each role generates structured analysis following best practices.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID (e.g. EXE-001)" },
        role: { type: "string", description: "Role name: BA, Designer, SystemAnalyst, Developer, or QA", enum: ["BA", "Designer", "SystemAnalyst", "Developer", "QA"] },
        content: { type: "string", description: "Role output content in markdown" },
      },
      required: ["project_path", "task_id", "role", "content"],
    },
  },
  {
    name: "get_role_output",
    description: "Read a specific role output for a task. Returns the content, status, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID (e.g. EXE-001)" },
        role: { type: "string", description: "Role name: BA, Designer, SystemAnalyst, Developer, or QA", enum: ["BA", "Designer", "SystemAnalyst", "Developer", "QA"] },
      },
      required: ["project_path", "task_id", "role"],
    },
  },

  // ── Relationships (2) ───────────────────────────────────────
  {
    name: "link_tasks",
    description: "Create a dependency relationship between two tasks. Updates both task files with wiki-links and frontmatter.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        source_task: { type: "string", description: "Source task ID (e.g. EXE-001)" },
        target_task: { type: "string", description: "Target task ID (e.g. EXE-002)" },
        relationship: { type: "string", description: "Relationship type", enum: ["blocked-by", "blocks", "subtask-of", "parent-of", "related-to"] },
      },
      required: ["project_path", "source_task", "target_task", "relationship"],
    },
  },
  {
    name: "get_task_graph",
    description: "Get dependency graph for a task. Returns connected nodes and a Mermaid diagram for Obsidian rendering.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Root task ID to start traversal from" },
        depth: { type: "integer", description: "Traversal depth (default: 2)" },
      },
      required: ["project_path", "task_id"],
    },
  },

  // ── Metrics (2) ─────────────────────────────────────────────
  {
    name: "get_velocity",
    description: "Calculate task completion velocity — tasks per period, average cycle time, throughput.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        period: { type: "string", description: "Time period: day, week, sprint, month (default: week)", enum: ["day", "week", "sprint", "month"] },
      },
      required: ["project_path"],
    },
  },
  {
    name: "get_burndown",
    description: "Get sprint burndown data with Mermaid chart for Obsidian rendering.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        sprint_number: { type: "integer", description: "Sprint number" },
      },
      required: ["project_path", "sprint_number"],
    },
  },

  // ── Cross-Project (3) ───────────────────────────────────────
  {
    name: "search_tasks",
    description: "Search tasks across all registered projects by query text, status, or tags.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text (matches task title, ID, body)" },
        status: { type: "string", description: "Filter by status: TODO, IN_PROGRESS, DONE, BLOCKED" },
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
      },
    },
  },
  {
    name: "create_cross_project_link",
    description: "Link tasks across different projects. Updates both task files and the shared cross-project links index.",
    inputSchema: {
      type: "object",
      properties: {
        source_project: { type: "string", description: "Source project repo ID or path" },
        source_task: { type: "string", description: "Source task ID" },
        target_project: { type: "string", description: "Target project repo ID or path" },
        target_task: { type: "string", description: "Target task ID" },
        relationship: { type: "string", description: "Relationship type", enum: ["blocked-by", "blocks", "related-to", "depends-on"] },
      },
      required: ["source_project", "source_task", "target_project", "target_task"],
    },
  },
  {
    name: "get_cross_project_deps",
    description: "Get cross-project dependency overview with Mermaid diagram.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: { type: "string", description: "Optional project path to scope results" },
      },
    },
  },

  // ── Sprint & Scheduling (5) ─────────────────────────────────
  {
    name: "schedule_task",
    description: "Assign a task to a specific date for day planning.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID (e.g. EXE-001)" },
        scheduled_date: { type: "string", description: "Date in YYYY-MM-DD format" },
      },
      required: ["project_path", "task_id", "scheduled_date"],
    },
  },
  {
    name: "get_schedule",
    description: "Get tasks scheduled for a date range. Shows overdue tasks. Defaults to today.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        start_date: { type: "string", description: "Start date YYYY-MM-DD (default: today)" },
        end_date: { type: "string", description: "End date YYYY-MM-DD (default: same as start_date)" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "create_sprint",
    description: "Create a sprint definition with dates and goals.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        sprint_number: { type: "integer", description: "Sprint number" },
        start_date: { type: "string", description: "Sprint start date YYYY-MM-DD" },
        end_date: { type: "string", description: "Sprint end date YYYY-MM-DD" },
        goals: { type: "array", items: { type: "string" }, description: "Sprint goals" },
      },
      required: ["project_path", "sprint_number", "start_date", "end_date"],
    },
  },
  {
    name: "assign_to_sprint",
    description: "Assign tasks to a sprint. Updates each task's sprint field and the sprint file.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_ids: { type: "array", items: { type: "string" }, description: "Task IDs to assign" },
        sprint_number: { type: "integer", description: "Sprint number to assign to" },
      },
      required: ["project_path", "task_ids", "sprint_number"],
    },
  },
  {
    name: "get_sprint",
    description: "Get sprint details with current task statuses. Use sprint_number='current' for the active sprint.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        sprint_number: { type: "string", description: "Sprint number or 'current' for active sprint" },
      },
      required: ["project_path"],
    },
  },

  // ── Visual & Agile (2) ──────────────────────────────────────
  {
    name: "generate_canvas",
    description: "Generate an Obsidian .canvas JSON file for visual board views (kanban, sprint, dependencies, architecture).",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        canvas_type: { type: "string", enum: ["architecture", "sprint", "dependencies", "kanban"], description: "Type of canvas to generate" },
        sprint_number: { type: "integer", description: "Sprint number (for sprint canvas type)" },
      },
      required: ["project_path", "canvas_type"],
    },
  },
  {
    name: "generate_retro",
    description: "Generate a sprint retrospective markdown file with velocity data and template sections.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        sprint_number: { type: "integer", description: "Sprint number to generate retro for" },
      },
      required: ["project_path", "sprint_number"],
    },
  },

  // ── Self-Learning (4) ───────────────────────────────────────
  {
    name: "learn_from_history",
    description: "Analyze execution history (tasks, sessions, corrections) to extract learning patterns. Writes Patterns.md and Project Profile.md.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        focus: { type: "string", enum: ["all", "intent", "priority", "cycle_time", "patterns"], description: "Focus area for analysis (default: all)" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "get_insights",
    description: "Surface actionable insights from learned patterns. Returns top insights filtered by context.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        context: { type: "string", description: "Current work type or task ID for contextual filtering" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "adapt_priority",
    description: "Suggest task priority based on learned correction patterns instead of just keyword matching.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        title: { type: "string", description: "Task title to analyze" },
        work_type: { type: "string", description: "Work type: bugfix, new_feature, refactor, docs, testing" },
      },
      required: ["project_path", "title"],
    },
  },
  {
    name: "get_learning_status",
    description: "Dashboard of what VaultOps has learned: data points, confidence, accuracy stats, staleness, suggestions.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },

  // ── Task-as-Code (1) ────────────────────────────────────────
  {
    name: "run_verify",
    description: "Run Task-as-Code verification checks for a task. Returns pass/fail for each check defined in the task's verify: frontmatter. Checks include: file_exists, file_changed, grep_content, test_pattern.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID (e.g. EXE-001)" },
      },
      required: ["project_path", "task_id"],
    },
  },

  // ── Predictive Brain (1) ────────────────────────────────────
  {
    name: "get_predictions",
    description: "Predictive Brain — forecast cycle time, risk level, and suggested priority for a task based on historical patterns. Shows confidence levels and reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        task_id: { type: "string", description: "Task ID to predict for (reads task details)" },
        work_type: { type: "string", description: "Work type: bugfix, new_feature, refactor, deploy, docs (auto-detected if task_id given)", enum: ["bugfix", "new_feature", "refactor", "deploy", "docs", "unknown"] },
        files: { type: "array", items: { type: "string" }, description: "Files that will be changed (for risk assessment)" },
      },
      required: ["project_path"],
    },
  },

  // ── Adaptive Roles (1) ──────────────────────────────────────
  {
    name: "get_project_dna",
    description: "Analyze role outputs to build Project DNA — the project's unique style profile (tech stack, test patterns, design approach). Used by role skills to adapt their output.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },

  // ── Ecosystem & Visibility (4) ──────────────────────────────
  {
    name: "get_replay",
    description: "Session Replay — digest of what happened in the last N hours: completed tasks, journal entries, stale docs, learning events. Perfect for starting a new work session.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        hours: { type: "integer", description: "Lookback period in hours (default: 24)" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "get_stale_docs",
    description: "Detect documentation that may be outdated — finds doc sections referencing files changed in recent tasks.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        hours: { type: "integer", description: "Lookback period in hours (default: 72)" },
      },
      required: ["project_path"],
    },
  },
  {
    name: "get_arch_radar",
    description: "Architecture Radar — detect coupling patterns (files that always change together), hotspots (most-changed files), and suggest ADRs. Generates Mermaid coupling diagram.",
    inputSchema: { type: "object", properties: { project_path: pp }, required: ["project_path"] },
  },
  {
    name: "generate_report",
    description: "Generate standalone HTML report for stakeholders. Zero dependencies, shareable as a single file. Includes donut chart, task table, velocity metrics.",
    inputSchema: {
      type: "object",
      properties: {
        project_path: pp,
        sprint_number: { type: "integer", description: "Sprint number to report on (optional, shows all tasks if omitted)" },
        output_path: { type: "string", description: "Output file path (default: project root)" },
      },
      required: ["project_path"],
    },
  },

  // ── Meeting Notes (7) ───────────────────────────────────────
  {
    name: "create_meeting",
    description: "Create a new meeting note from template with auto-incremented MTG-### ID. Supports meeting series defaults for recurring meetings.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title" },
        date: { type: "string", description: "Meeting date (YYYY-MM-DD, default: today)" },
        meeting_type: { type: "string", description: "Type: product, business, sync, standup (default: product)" },
        series: { type: "string", description: "Series ID for recurring meetings (auto-fills participants/projects from series defaults)" },
        participants: { type: "array", items: { type: "string" }, description: "List of participant names" },
        projects: { type: "array", items: { type: "string" }, description: "List of affected project repo IDs" },
      },
      required: ["title"],
    },
  },
  {
    name: "get_meeting",
    description: "Read a meeting note by MTG-### ID or date.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: { type: "string", description: "Meeting ID (e.g. MTG-001)" },
        date: { type: "string", description: "Meeting date (YYYY-MM-DD) — used if meeting_id not provided" },
      },
    },
  },
  {
    name: "dispatch_action_items",
    description: "Parse action items table from a meeting note and create tasks in target project task boards. Each task gets tagged with meeting/MTG-### for traceability.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: { type: "string", description: "Meeting ID (e.g. MTG-001)" },
        dry_run: { type: "boolean", description: "If true, shows proposed task assignments without creating them (default: false)" },
      },
      required: ["meeting_id"],
    },
  },
  {
    name: "link_decision_to_adr",
    description: "Link a meeting decision to an Architecture Decision Record in a project. Creates ADR stub if no adr_id provided.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: { type: "string", description: "Meeting ID" },
        decision: { type: "string", description: "Decision text" },
        project: { type: "string", description: "Target project repo ID" },
        adr_id: { type: "string", description: "Existing ADR ID to link to (creates new if omitted)" },
      },
      required: ["meeting_id", "decision", "project"],
    },
  },
  {
    name: "create_followup",
    description: "Create a scheduled follow-up task from a meeting. Tagged with followup/MTG-### for tracking.",
    inputSchema: {
      type: "object",
      properties: {
        meeting_id: { type: "string", description: "Meeting ID" },
        description: { type: "string", description: "Follow-up description" },
        due_date: { type: "string", description: "Due date (YYYY-MM-DD)" },
        assignee: { type: "string", description: "Person responsible" },
        project: { type: "string", description: "Target project repo ID" },
      },
      required: ["meeting_id", "description"],
    },
  },
  {
    name: "get_meeting_dashboard",
    description: "Dashboard of recent meetings, undispatched action items, overdue follow-ups, and upcoming series.",
    inputSchema: {
      type: "object",
      properties: {
        days_back: { type: "integer", description: "How many days back to look (default: 14)" },
        project: { type: "string", description: "Filter by project repo ID" },
      },
    },
  },
  {
    name: "get_meeting_series",
    description: "List or manage recurring meeting series. Use action=create with name/cadence to create a new series.",
    inputSchema: {
      type: "object",
      properties: {
        series_id: { type: "string", description: "Series ID to get details (omit to list all)" },
        action: { type: "string", description: "Action: list (default) or create" },
        name: { type: "string", description: "Series name (for create)" },
        cadence: { type: "string", description: "Cadence: weekly, biweekly, monthly (for create, default: weekly)" },
        default_participants: { type: "array", items: { type: "string" }, description: "Default participants (for create)" },
        default_projects: { type: "array", items: { type: "string" }, description: "Default affected projects (for create)" },
      },
    },
  },
];

// ── Public API ────────────────────────────────────────────────────────────

export function listTools(): { tools: ToolDefinition[] } {
  return { tools: toolDefinitions };
}

export function callTool(name: string, args: ToolArgs): ToolResult {
  const handler = handlers[name];
  if (!handler) {
    return toolResult({ error: `Unknown tool: ${name}` }, true);
  }

  try {
    return handler(args);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult({ error: msg }, true);
  }
}
