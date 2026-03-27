/**
 * VaultOps Vault Janitor — Stop hook for vault hygiene.
 *
 * Runs after session_summary on every session end.
 * Checks all registered project vaults and:
 *   - Rotates oversized Execution Journal
 *   - Archives old Learning Log entries (> 30 days)
 *   - Deletes orphaned /tmp/vaultops-brain-*.json files
 *   - Detects orphaned Role Output directories
 *   - Detects suspiciously small task files
 *   - Warns about stale DONE tasks
 *   - Calls Claude Haiku for a natural-language health summary (optional)
 *
 * Never crashes the Stop hook.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import { isVaultopsProject } from "./shared/brain-state.js";

// Tunables
const FREQ_GATE_HOURS = 1.0;
const JOURNAL_ROTATE_LINES = 500;
const JOURNAL_KEEP_LINES = 200;
const LEARNING_ARCHIVE_DAYS = 30;
const TASK_STALE_DONE_DAYS = 90;
const ORPHAN_TMP_HOURS = 24;
const MIN_TASK_LINES = 5;

// Paths — validate env overrides stay within expected directory
function resolveConfigPath(envVar: string, defaultPath: string): string {
  const raw = process.env[envVar];
  if (!raw) return path.resolve(defaultPath);
  const resolved = path.resolve(raw);
  const vaultopsDir = path.resolve(os.homedir(), ".vaultops");
  const rel = path.relative(vaultopsDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // Env var points outside ~/.vaultops — fall back to default for safety
    return path.resolve(defaultPath);
  }
  return resolved;
}

const PROJECTS_JSON = resolveConfigPath(
  "VAULTOPS_PROJECTS_JSON",
  path.join(os.homedir(), ".vaultops", "state", "projects.json"),
);
const JANITOR_STATE = resolveConfigPath(
  "VAULTOPS_JANITOR_STATE",
  path.join(os.homedir(), ".vaultops", "state", "janitor.json"),
);

const EXEC_DIR = "08-Execution";
const EXEC_JOURNAL = "Execution Journal.md";
const TASKS_DIR = "Tasks";
const ROLE_OUTPUTS_DIR = "Role Outputs";
const LEARNINGS_DIR = "Learnings";
const LEARNING_LOG = "Learning Log.md";

const SEP = "\u2500".repeat(43);

// Registry
function getVaultRoots(): Array<[string, string]> {
  if (!fs.existsSync(PROJECTS_JSON)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_JSON, "utf-8"));
    const result: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const proj of data.projects ?? []) {
      const vaultRoot = proj.vaultRoot ?? "";
      if (!vaultRoot || seen.has(vaultRoot)) continue;
      try { if (!fs.statSync(vaultRoot).isDirectory()) continue; } catch { continue; }
      seen.add(vaultRoot);
      const name = proj.name || proj.repoId || path.basename(proj.path ?? "unknown");
      result.push([name, vaultRoot]);
    }
    return result;
  } catch { return []; }
}

// Frequency gate
function shouldRun(projectPath: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(JANITOR_STATE, "utf-8"));
    const lastRun = data[projectPath]?.last_run;
    if (!lastRun) return true;
    const elapsed = (Date.now() - new Date(lastRun).getTime()) / 3600000;
    return elapsed >= FREQ_GATE_HOURS;
  } catch { return true; }
}

function markRun(projectPath: string): void {
  try {
    fs.mkdirSync(path.dirname(JANITOR_STATE), { recursive: true });
    let data: Record<string, Record<string, string>> = {};
    try { data = JSON.parse(fs.readFileSync(JANITOR_STATE, "utf-8")); } catch { /* ignore */ }
    data[projectPath] = { ...data[projectPath], last_run: new Date().toISOString() };
    const tmp = JANITOR_STATE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
    fs.renameSync(tmp, JANITOR_STATE);
  } catch { /* ignore */ }
}

// Journal rotation
function rotateJournal(vaultRoot: string): string | null {
  const journalPath = path.join(vaultRoot, EXEC_DIR, EXEC_JOURNAL);
  if (!fs.existsSync(journalPath)) return null;

  const lines = fs.readFileSync(journalPath, "utf-8").split("\n");
  if (lines.length <= JOURNAL_ROTATE_LINES) return null;

  const archiveLines = lines.slice(0, -JOURNAL_KEEP_LINES);
  const keepLines = lines.slice(-JOURNAL_KEEP_LINES);

  // Derive archive month
  let monthStr = new Date().toISOString().slice(0, 7);
  for (const line of archiveLines) {
    const m = line.match(/(\d{4}-\d{2})-\d{2}/);
    if (m) { monthStr = m[1]; break; }
  }

  const archiveName = `Execution Journal Archive ${monthStr}.md`;
  const archivePath = path.join(vaultRoot, EXEC_DIR, archiveName);

  let existing = "";
  if (fs.existsSync(archivePath)) {
    existing = fs.readFileSync(archivePath, "utf-8");
  } else {
    existing = `# Execution Journal Archive \u2014 ${monthStr}\n\n`;
  }

  const tmpArchive = archivePath + ".tmp";
  fs.writeFileSync(tmpArchive, existing + archiveLines.join("\n"), "utf-8");
  fs.renameSync(tmpArchive, archivePath);

  const tmpJournal = journalPath + ".tmp";
  fs.writeFileSync(tmpJournal, keepLines.join("\n"), "utf-8");
  fs.renameSync(tmpJournal, journalPath);

  return `Archived ${archiveLines.length} lines \u2192 ${archiveName}`;
}

// Learning Log archival
function archiveLearningLog(vaultRoot: string): string | null {
  const logPath = path.join(vaultRoot, EXEC_DIR, LEARNINGS_DIR, LEARNING_LOG);
  if (!fs.existsSync(logPath)) return null;

  const content = fs.readFileSync(logPath, "utf-8");
  const parts = content.split(/(?=^## )/m);
  const headerParts = parts.filter(p => !p.startsWith("## "));
  const events = parts.filter(p => p.startsWith("## "));

  if (events.length <= 20) return null;

  const cutoff = new Date(Date.now() - LEARNING_ARCHIVE_DAYS * 86400000);
  const oldEvents: string[] = [];
  const newEvents: string[] = [];

  for (const event of events) {
    const m = event.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    if (m) {
      try {
        const dt = new Date(m[1] + "Z");
        if (dt < cutoff) { oldEvents.push(event); continue; }
      } catch { /* ignore */ }
    }
    newEvents.push(event);
  }

  if (!oldEvents.length) return null;

  let monthStr = new Date().toISOString().slice(0, 7);
  for (const event of oldEvents) {
    const m = event.match(/(\d{4}-\d{2})-\d{2}/);
    if (m) { monthStr = m[1]; break; }
  }

  const archiveDir = path.join(vaultRoot, EXEC_DIR, LEARNINGS_DIR, "Archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${monthStr}.md`);

  let existingArchive = "";
  if (fs.existsSync(archivePath)) {
    existingArchive = fs.readFileSync(archivePath, "utf-8");
  } else {
    existingArchive = `# Learning Log Archive \u2014 ${monthStr}\n\n`;
  }

  const tmpArchive = archivePath + ".tmp";
  fs.writeFileSync(tmpArchive, existingArchive + oldEvents.join(""), "utf-8");
  fs.renameSync(tmpArchive, archivePath);

  const newContent = headerParts.join("") + newEvents.join("");
  const tmpLog = logPath + ".tmp";
  fs.writeFileSync(tmpLog, newContent, "utf-8");
  fs.renameSync(tmpLog, logPath);

  return `Archived ${oldEvents.length} Learning Log entries \u2192 Archive/${monthStr}.md`;
}

// Orphaned /tmp files
function cleanupOrphanedTmp(): number {
  const cutoff = Date.now() - ORPHAN_TMP_HOURS * 3600000;
  let deleted = 0;
  const tmpDir = os.tmpdir();
  try {
    for (const fname of fs.readdirSync(tmpDir)) {
      if (!fname.startsWith("vaultops-brain-") || (!fname.endsWith(".json") && !fname.endsWith(".json.tmp"))) continue;
      const fp = path.join(tmpDir, fname);
      try {
        const mtime = fs.statSync(fp).mtimeMs;
        if (mtime < cutoff) { fs.unlinkSync(fp); deleted++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return deleted;
}

// Orphaned Role Outputs
function findOrphanedRoleOutputs(vaultRoot: string): string[] {
  const tasksDir = path.join(vaultRoot, EXEC_DIR, TASKS_DIR);
  const roleDir = path.join(vaultRoot, EXEC_DIR, ROLE_OUTPUTS_DIR);

  try { if (!fs.statSync(tasksDir).isDirectory() || !fs.statSync(roleDir).isDirectory()) return []; } catch { return []; }

  const existingTasks = new Set(
    fs.readdirSync(tasksDir).filter(f => f.endsWith(".md")).map(f => f.slice(0, -3)),
  );

  return fs.readdirSync(roleDir)
    .filter(d => {
      try { return fs.statSync(path.join(roleDir, d)).isDirectory() && !existingTasks.has(d); } catch { return false; }
    })
    .sort();
}

// Stale DONE tasks
function findStaleDoneTasks(vaultRoot: string): string[] {
  const tasksDir = path.join(vaultRoot, EXEC_DIR, TASKS_DIR);
  try { if (!fs.statSync(tasksDir).isDirectory()) return []; } catch { return []; }

  const cutoff = Date.now() - TASK_STALE_DONE_DAYS * 86400000;
  const stale: string[] = [];

  for (const fname of fs.readdirSync(tasksDir)) {
    if (!fname.endsWith(".md")) continue;
    const fpath = path.join(tasksDir, fname);
    try {
      const head = fs.readFileSync(fpath, "utf-8").slice(0, 1024);
      const statusM = head.match(/^status:\s*(\S+)/im);
      if (!statusM || statusM[1].replace(/['"]/g, "").toUpperCase() !== "DONE") continue;

      // Try frontmatter completion date
      const dateM = head.match(/^(?:completed_at|updated_at|done_at):\s*(.+)$/im);
      if (dateM) {
        try {
          const dt = new Date(dateM[1].trim().replace(/['"]/g, "").replace("Z", "+00:00"));
          if (dt.getTime() < cutoff) stale.push(fname.slice(0, -3));
          continue;
        } catch { /* fall through */ }
      }

      // Fallback: file mtime
      if (fs.statSync(fpath).mtimeMs < cutoff) stale.push(fname.slice(0, -3));
    } catch { /* ignore */ }
  }
  return stale.sort();
}

// Corrupted task files
function findCorruptedTasks(vaultRoot: string): string[] {
  const tasksDir = path.join(vaultRoot, EXEC_DIR, TASKS_DIR);
  try { if (!fs.statSync(tasksDir).isDirectory()) return []; } catch { return []; }

  const suspicious: string[] = [];
  for (const fname of fs.readdirSync(tasksDir)) {
    if (!fname.endsWith(".md")) continue;
    try {
      const lines = fs.readFileSync(path.join(tasksDir, fname), "utf-8").split("\n");
      if (lines.length > 0 && lines.length < MIN_TASK_LINES) suspicious.push(fname.slice(0, -3));
    } catch { /* ignore */ }
  }
  return suspicious.sort();
}

// Health score
function healthScore(orphans: number, stale: number, corrupted: number): number {
  let score = 100;
  score -= Math.min(orphans * 5, 20);
  score -= Math.min(stale * 2, 20);
  score -= Math.min(corrupted * 10, 30);
  return Math.max(0, score);
}

// Haiku summary
function haikuReport(stats: Record<string, number>): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) return Promise.resolve(null);

  return new Promise(resolve => {
    try {
      const prompt =
        "\u0422\u044b \u0430\u043d\u0430\u043b\u0438\u0442\u0438\u043a \u0437\u0434\u043e\u0440\u043e\u0432\u044c\u044f Obsidian vault \u0434\u043b\u044f \u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u0447\u0438\u043a\u0430. " +
        "\u041f\u043e \u044d\u0442\u043e\u0439 \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0435 \u043d\u0430\u043f\u0438\u0448\u0438 2-3 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f \u043e \u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0438 vault \u043d\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u043c " +
        "\u0438 \u043e\u0434\u043d\u0443 \u043a\u043e\u043d\u043a\u0440\u0435\u0442\u043d\u0443\u044e \u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0438\u044e.\n\n" +
        `\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0430: ${JSON.stringify(stats)}\n\n` +
        "\u041f\u0440\u0430\u0432\u0438\u043b\u0430: \u043a\u0440\u0430\u0442\u043a\u043e, \u043a\u043e\u043d\u043a\u0440\u0435\u0442\u043d\u043e, \u0434\u0440\u0443\u0436\u0435\u043b\u044e\u0431\u043d\u043e. \u0415\u0441\u043b\u0438 \u0432\u0441\u0451 \u0447\u0438\u0441\u0442\u043e \u2014 \u0441\u043a\u0430\u0436\u0438 \u043a\u0440\u0430\u0442\u043a\u043e.\n" +
        "\u0424\u043e\u0440\u043c\u0430\u0442 \u0432\u044b\u0432\u043e\u0434\u0430 \u0441\u0442\u0440\u043e\u0433\u043e: {{emoji}} {{2-3 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f}}\n\ud83d\udca1 {{\u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434\u0430\u0446\u0438\u044f}}";

      const payload = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      });

      const req = https.request(
        {
          hostname: "api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
          timeout: 10000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk; });
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve(data.content?.[0]?.text?.trim() ?? null);
            } catch { resolve(null); }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    } catch { resolve(null); }
  });
}

// Main
async function main(): Promise<void> {
  const projectPath = process.cwd();

  if (!isVaultopsProject(projectPath)) return;
  if (!shouldRun(projectPath)) return;

  markRun(projectPath);

  // Find all registered vaults
  let vaultRoots = getVaultRoots();
  if (!vaultRoots.length) {
    try {
      const { resolveVaultProject } = require("../vault/resolve.js");
      const vr = resolveVaultProject(projectPath);
      if (vr) vaultRoots = [[path.basename(projectPath), vr]];
    } catch { /* ignore */ }
  }

  if (!vaultRoots.length) return;

  // Global cleanup
  const allActions: string[] = [];
  const allWarnings: string[] = [];

  const orphanTmp = cleanupOrphanedTmp();
  if (orphanTmp) {
    allActions.push(`Deleted ${orphanTmp} orphaned /tmp/vaultops-brain-*.json (sessions > ${ORPHAN_TMP_HOURS}h)`);
  }

  // Per-vault cleanup
  let totalOrphans = 0;
  let totalStale = 0;
  let totalCorrupted = 0;

  for (const [name, vaultRoot] of vaultRoots) {
    const prefix = vaultRoots.length > 1 ? `[${name}] ` : "";

    // Journal rotation
    try {
      const action = rotateJournal(vaultRoot);
      if (action) allActions.push(`${prefix}Journal: ${action}`);
    } catch { /* ignore */ }

    // Learning Log archival
    try {
      const action = archiveLearningLog(vaultRoot);
      if (action) allActions.push(`${prefix}Learning Log: ${action}`);
    } catch { /* ignore */ }

    // Orphaned Role Outputs
    try {
      const orphans = findOrphanedRoleOutputs(vaultRoot);
      if (orphans.length) {
        let display = orphans.slice(0, 5).join(", ");
        if (orphans.length > 5) display += ` +${orphans.length - 5}`;
        allWarnings.push(`${prefix}${orphans.length} orphaned Role Output${orphans.length > 1 ? "s" : ""}: ${display}`);
        totalOrphans += orphans.length;
      }
    } catch { /* ignore */ }

    // Stale DONE tasks
    try {
      const stale = findStaleDoneTasks(vaultRoot);
      if (stale.length) {
        let display = stale.slice(0, 5).join(", ");
        if (stale.length > 5) display += ` +${stale.length - 5}`;
        allWarnings.push(`${prefix}${stale.length} DONE task${stale.length > 1 ? "s" : ""} older than ${TASK_STALE_DONE_DAYS} days: ${display}`);
        totalStale += stale.length;
      }
    } catch { /* ignore */ }

    // Corrupted task files
    try {
      const corrupted = findCorruptedTasks(vaultRoot);
      if (corrupted.length) {
        allWarnings.push(`${prefix}\u26a1 ${corrupted.length} suspiciously small task file${corrupted.length > 1 ? "s" : ""}: ${corrupted.slice(0, 5).join(", ")}`);
        totalCorrupted += corrupted.length;
      }
    } catch { /* ignore */ }
  }

  // Nothing to report → stay silent
  if (!allActions.length && !allWarnings.length) return;

  // Haiku
  const stats = {
    orphaned_tmp_deleted: orphanTmp,
    journal_rotations: allActions.filter(a => a.includes("Journal")).length,
    learning_log_archived: allActions.filter(a => a.includes("Learning Log")).length,
    orphaned_role_outputs: totalOrphans,
    stale_done_tasks: totalStale,
    corrupted_task_files: totalCorrupted,
    vaults_scanned: vaultRoots.length,
  };
  const score = healthScore(totalOrphans, totalStale, totalCorrupted);
  const haiku = await haikuReport(stats);

  // Print report
  const out: string[] = ["", SEP, "\ud83d\uddd1\ufe0f  Vault Janitor", ""];

  if (allActions.length) {
    out.push("\u2705 Done:");
    for (const a of allActions) out.push(`   \u00b7 ${a}`);
    out.push("");
  }

  if (allWarnings.length) {
    out.push("\u26a0\ufe0f  Found:");
    for (const w of allWarnings) out.push(`   \u00b7 ${w}`);
    out.push("");
  }

  if (haiku) {
    out.push(`\ud83e\udd16 ${haiku}`);
    out.push("");
  }

  out.push(`Score: ${score}/100`);
  out.push(SEP);
  out.push("");

  process.stdout.write(out.join("\n"));
}

main().catch(() => { /* Never crash the Stop hook */ });
