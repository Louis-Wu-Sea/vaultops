#!/usr/bin/env python3
"""VaultOps Vault Janitor — Stop hook for vault hygiene.

Runs after session_summary.py on every session end.
Checks all registered project vaults and:
  - Rotates oversized Execution Journal (archive old entries, keep last 200 lines)
  - Archives old Learning Log entries (> 30 days) into monthly files
  - Deletes orphaned /tmp/vaultops-brain-*.json files (> 24h, from crashed sessions)
  - Detects orphaned Role Output directories (task was deleted, folder remains)
  - Detects suspiciously small task files (possible partial writes)
  - Warns about stale DONE tasks (> 90 days, suggest archiving)
  - Calls Claude Haiku for a natural-language health summary (optional)

Python stdlib only. Silent when vault is clean. Never crashes the Stop hook.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

_hooks_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _hooks_dir)
sys.path.insert(0, os.path.dirname(_hooks_dir))

from brain_state import is_vaultops_project  # noqa: E402


# ── Tunables ──────────────────────────────────────────────────────────────

FREQ_GATE_HOURS = 1.0           # Skip if janitor already ran < N hours ago
JOURNAL_ROTATE_LINES = 500      # Rotate when journal exceeds this many lines
JOURNAL_KEEP_LINES = 200        # Lines to keep in active journal after rotation
LEARNING_ARCHIVE_DAYS = 30      # Archive learning log entries older than N days
TASK_STALE_DONE_DAYS = 90       # Flag DONE tasks older than N days
ORPHAN_TMP_HOURS = 24           # Delete orphaned /tmp state files older than N hours
MIN_TASK_LINES = 5              # Task files with fewer lines are suspicious

# ── Paths ─────────────────────────────────────────────────────────────────

PROJECTS_JSON = os.path.expanduser(
    os.environ.get("VAULTOPS_PROJECTS_JSON", "~/.vaultops/state/projects.json")
)
JANITOR_STATE = os.path.expanduser(
    os.environ.get("VAULTOPS_JANITOR_STATE", "~/.vaultops/state/janitor.json")
)

EXEC_DIR = "08-Execution"
EXEC_JOURNAL = "Execution Journal.md"
TASKS_DIR = "Tasks"
ROLE_OUTPUTS_DIR = "Role Outputs"
LEARNINGS_DIR = "Learnings"
LEARNING_LOG = "Learning Log.md"

_SEP = "\u2500" * 43


# ── Registry ──────────────────────────────────────────────────────────────

def _get_vault_roots() -> List[Tuple[str, str]]:
    """Return [(project_name, vault_root)] for all registered projects, deduplicated."""
    if not os.path.isfile(PROJECTS_JSON):
        return []
    try:
        with open(PROJECTS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        result = []
        seen: set = set()
        for proj in data.get("projects", []):
            vault_root = proj.get("vaultRoot", "")
            if not vault_root or not os.path.isdir(vault_root):
                continue
            if vault_root in seen:
                continue
            seen.add(vault_root)
            name = (
                proj.get("name")
                or proj.get("repoId")
                or os.path.basename(proj.get("path", "unknown"))
            )
            result.append((name, vault_root))
        return result
    except (json.JSONDecodeError, OSError):
        return []


# ── Frequency gate ────────────────────────────────────────────────────────

def _should_run(project_path: str) -> bool:
    """Return True if enough time has passed since last janitor run."""
    try:
        with open(JANITOR_STATE, "r", encoding="utf-8") as f:
            data = json.load(f)
        last_run = data.get(project_path, {}).get("last_run")
        if not last_run:
            return True
        last_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
        elapsed_h = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
        return elapsed_h >= FREQ_GATE_HOURS
    except (FileNotFoundError, json.JSONDecodeError, ValueError, TypeError, OSError):
        return True


def _mark_run(project_path: str) -> None:
    """Persist last-run timestamp for this project."""
    try:
        os.makedirs(os.path.dirname(JANITOR_STATE), exist_ok=True)
        data: Dict[str, Any] = {}
        try:
            with open(JANITOR_STATE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        data.setdefault(project_path, {})["last_run"] = (
            datetime.now(timezone.utc).isoformat()
        )
        tmp = JANITOR_STATE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, JANITOR_STATE)
    except OSError:
        pass


# ── Journal rotation ──────────────────────────────────────────────────────

def _rotate_journal(vault_root: str) -> Optional[str]:
    """Archive old journal lines if file exceeds JOURNAL_ROTATE_LINES."""
    journal_path = os.path.join(vault_root, EXEC_DIR, EXEC_JOURNAL)
    if not os.path.isfile(journal_path):
        return None

    with open(journal_path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    if len(lines) <= JOURNAL_ROTATE_LINES:
        return None

    archive_lines = lines[:-JOURNAL_KEEP_LINES]
    keep_lines = lines[-JOURNAL_KEEP_LINES:]

    # Derive archive month from earliest entry in the chunk
    month_str = datetime.now(timezone.utc).strftime("%Y-%m")
    for line in archive_lines:
        m = re.search(r"(\d{4}-\d{2})-\d{2}", line)
        if m:
            month_str = m.group(1)
            break

    archive_name = f"Execution Journal Archive {month_str}.md"
    archive_path = os.path.join(vault_root, EXEC_DIR, archive_name)

    # Build archive content (existing + new chunk) atomically
    existing = ""
    if os.path.isfile(archive_path):
        with open(archive_path, "r", encoding="utf-8", errors="replace") as f:
            existing = f.read()
    else:
        existing = f"# Execution Journal Archive — {month_str}\n\n"

    tmp_archive = archive_path + ".tmp"
    with open(tmp_archive, "w", encoding="utf-8") as f:
        f.write(existing)
        f.writelines(archive_lines)
    os.replace(tmp_archive, archive_path)

    # Atomically write trimmed journal back
    tmp_journal = journal_path + ".tmp"
    with open(tmp_journal, "w", encoding="utf-8") as f:
        f.writelines(keep_lines)
    os.replace(tmp_journal, journal_path)

    return f"Архивировано {len(archive_lines)} строк → {archive_name}"


# ── Learning Log archival ─────────────────────────────────────────────────

def _archive_learning_log(vault_root: str) -> Optional[str]:
    """Move Learning Log entries older than LEARNING_ARCHIVE_DAYS to monthly files."""
    log_path = os.path.join(vault_root, EXEC_DIR, LEARNINGS_DIR, LEARNING_LOG)
    if not os.path.isfile(log_path):
        return None

    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    # Split on entry boundaries (each entry starts with "## ")
    parts = re.split(r"(?=^## )", content, flags=re.MULTILINE)
    header_parts = [p for p in parts if not p.startswith("## ")]
    events = [p for p in parts if p.startswith("## ")]

    if len(events) <= 20:
        return None  # Too small to bother

    cutoff = datetime.now(timezone.utc) - timedelta(days=LEARNING_ARCHIVE_DAYS)
    old_events: List[str] = []
    new_events: List[str] = []

    for event in events:
        m = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})", event)
        if m:
            try:
                dt = datetime.fromisoformat(m.group(1) + "+00:00")
                if dt < cutoff:
                    old_events.append(event)
                else:
                    new_events.append(event)
                continue
            except ValueError:
                pass
        new_events.append(event)

    if not old_events:
        return None

    # Determine month from oldest archived entry
    month_str = datetime.now(timezone.utc).strftime("%Y-%m")
    for event in old_events:
        m = re.search(r"(\d{4}-\d{2})-\d{2}", event)
        if m:
            month_str = m.group(1)
            break

    archive_dir = os.path.join(vault_root, EXEC_DIR, LEARNINGS_DIR, "Archive")
    os.makedirs(archive_dir, exist_ok=True)
    archive_path = os.path.join(archive_dir, f"{month_str}.md")

    # Build archive content atomically
    existing_archive = ""
    if os.path.isfile(archive_path):
        with open(archive_path, "r", encoding="utf-8", errors="replace") as f:
            existing_archive = f.read()
    else:
        existing_archive = f"# Learning Log Archive — {month_str}\n\n"

    tmp_archive = archive_path + ".tmp"
    with open(tmp_archive, "w", encoding="utf-8") as f:
        f.write(existing_archive)
        for e in old_events:
            f.write(e)
    os.replace(tmp_archive, archive_path)

    # Atomically write trimmed log back
    new_content = "".join(header_parts) + "".join(new_events)
    tmp_log = log_path + ".tmp"
    with open(tmp_log, "w", encoding="utf-8") as f:
        f.write(new_content)
    os.replace(tmp_log, log_path)

    return f"Архивировано {len(old_events)} записей Learning Log → Archive/{month_str}.md"


# ── Orphaned /tmp files ───────────────────────────────────────────────────

def _cleanup_orphaned_tmp() -> int:
    """Delete vaultops brain state temp files and leftover .tmp rotation files older than ORPHAN_TMP_HOURS."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=ORPHAN_TMP_HOURS)
    deleted = 0
    patterns = [
        os.path.join(tempfile.gettempdir(), "vaultops-brain-*.json"),
        os.path.join(tempfile.gettempdir(), "vaultops-brain-*.json.tmp"),
    ]
    for pattern in patterns:
        for fp in glob.glob(pattern):
            try:
                mtime = datetime.fromtimestamp(os.path.getmtime(fp), tz=timezone.utc)
                if mtime < cutoff:
                    os.unlink(fp)
                    deleted += 1
            except OSError:
                pass
    return deleted


# ── Orphaned Role Outputs ─────────────────────────────────────────────────

def _find_orphaned_role_outputs(vault_root: str) -> List[str]:
    """Return Role Output dir names that have no matching task file."""
    tasks_dir = os.path.join(vault_root, EXEC_DIR, TASKS_DIR)
    role_dir = os.path.join(vault_root, EXEC_DIR, ROLE_OUTPUTS_DIR)

    if not os.path.isdir(tasks_dir) or not os.path.isdir(role_dir):
        return []

    existing_tasks = {
        fname[:-3]  # strip .md
        for fname in os.listdir(tasks_dir)
        if fname.endswith(".md")
    }

    orphans = [
        dname
        for dname in os.listdir(role_dir)
        if os.path.isdir(os.path.join(role_dir, dname)) and dname not in existing_tasks
    ]
    return sorted(orphans)


# ── Stale DONE tasks ──────────────────────────────────────────────────────

def _find_stale_done_tasks(vault_root: str) -> List[str]:
    """Return task IDs that are DONE and older than TASK_STALE_DONE_DAYS."""
    tasks_dir = os.path.join(vault_root, EXEC_DIR, TASKS_DIR)
    if not os.path.isdir(tasks_dir):
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=TASK_STALE_DONE_DAYS)
    stale = []

    for fname in os.listdir(tasks_dir):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(tasks_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(1024)

            status_m = re.search(r"^status:\s*(\S+)", head, re.MULTILINE | re.IGNORECASE)
            if not status_m or status_m.group(1).strip().strip('\'"').upper() != "DONE":
                continue

            # Try frontmatter completion date first
            date_m = re.search(
                r"^(?:completed_at|updated_at|done_at):\s*(.+)$",
                head,
                re.MULTILINE | re.IGNORECASE,
            )
            if date_m:
                try:
                    dt = datetime.fromisoformat(
                        date_m.group(1).strip().strip('\'"').replace("Z", "+00:00")
                    )
                    if dt < cutoff:
                        stale.append(fname[:-3])
                    continue
                except ValueError:
                    pass

            # Fallback: file mtime
            mtime = datetime.fromtimestamp(os.path.getmtime(fpath), tz=timezone.utc)
            if mtime < cutoff:
                stale.append(fname[:-3])

        except OSError:
            pass

    return sorted(stale)


# ── Corrupted task files ──────────────────────────────────────────────────

def _find_corrupted_tasks(vault_root: str) -> List[str]:
    """Return task IDs for files that are suspiciously small (< MIN_TASK_LINES)."""
    tasks_dir = os.path.join(vault_root, EXEC_DIR, TASKS_DIR)
    if not os.path.isdir(tasks_dir):
        return []

    suspicious = []
    for fname in os.listdir(tasks_dir):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(tasks_dir, fname)
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            if 0 < len(lines) < MIN_TASK_LINES:
                suspicious.append(fname[:-3])
        except OSError:
            pass

    return sorted(suspicious)


# ── Health score ──────────────────────────────────────────────────────────

def _health_score(orphans: int, stale: int, corrupted: int) -> int:
    score = 100
    score -= min(orphans * 5, 20)
    score -= min(stale * 2, 20)
    score -= min(corrupted * 10, 30)
    return max(0, score)


# ── Haiku summary ─────────────────────────────────────────────────────────

def _haiku_report(stats: Dict[str, Any]) -> Optional[str]:
    """Ask Claude Haiku for a natural-language vault health summary. Returns None on any failure."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    try:
        import urllib.request

        prompt = (
            "Ты аналитик здоровья Obsidian vault для разработчика. "
            "По этой статистике напиши 2-3 предложения о состоянии vault на русском "
            "и одну конкретную рекомендацию.\n\n"
            f"Статистика: {json.dumps(stats, ensure_ascii=False)}\n\n"
            "Правила: кратко, конкретно, дружелюбно. Если всё чисто — скажи кратко.\n"
            "Формат вывода строго: {{emoji}} {{2-3 предложения}}\n💡 {{рекомендация}}"
        )

        payload = json.dumps(
            {
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 150,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["content"][0]["text"].strip()

    except Exception:
        return None


# ── Main ──────────────────────────────────────────────────────────────────

def main() -> None:
    project_path = os.getcwd()

    if not is_vaultops_project(project_path):
        return

    if not _should_run(project_path):
        return

    _mark_run(project_path)

    # Find all registered vaults; fallback to current project
    vault_roots = _get_vault_roots()
    if not vault_roots:
        try:
            from vaultops_mcp_server import _resolve_vault_project  # noqa: E402
            vr = _resolve_vault_project(project_path)
            if vr:
                vault_roots = [(os.path.basename(project_path), vr)]
        except Exception:
            pass

    if not vault_roots:
        return

    # ── Global cleanup ────────────────────────────────────────────────────
    all_actions: List[str] = []
    all_warnings: List[str] = []

    orphan_tmp = _cleanup_orphaned_tmp()
    if orphan_tmp:
        all_actions.append(
            f"Удалено {orphan_tmp} orphaned /tmp/vaultops-brain-*.json "
            f"(сессии старше {ORPHAN_TMP_HOURS}ч)"
        )

    # ── Per-vault cleanup ─────────────────────────────────────────────────
    total_orphans = 0
    total_stale = 0
    total_corrupted = 0

    for name, vault_root in vault_roots:
        prefix = f"[{name}] " if len(vault_roots) > 1 else ""

        # Journal rotation
        try:
            action = _rotate_journal(vault_root)
            if action:
                all_actions.append(f"{prefix}Журнал: {action}")
        except Exception:
            pass

        # Learning Log archival
        try:
            action = _archive_learning_log(vault_root)
            if action:
                all_actions.append(f"{prefix}Learning Log: {action}")
        except Exception:
            pass

        # Orphaned Role Outputs
        orphans: List[str] = []
        try:
            orphans = _find_orphaned_role_outputs(vault_root)
            if orphans:
                display = ", ".join(orphans[:5])
                if len(orphans) > 5:
                    display += f" +{len(orphans) - 5}"
                all_warnings.append(
                    f"{prefix}{len(orphans)} orphaned Role Output"
                    f"{'s' if len(orphans) > 1 else ''}: {display}"
                )
                total_orphans += len(orphans)
        except Exception:
            pass

        # Stale DONE tasks
        stale: List[str] = []
        try:
            stale = _find_stale_done_tasks(vault_root)
            if stale:
                display = ", ".join(stale[:5])
                if len(stale) > 5:
                    display += f" +{len(stale) - 5}"
                all_warnings.append(
                    f"{prefix}{len(stale)} DONE "
                    f"{'задача' if len(stale) == 1 else 'задачи'} "
                    f"старше {TASK_STALE_DONE_DAYS} дней: {display}"
                )
                total_stale += len(stale)
        except Exception:
            pass

        # Corrupted task files
        corrupted: List[str] = []
        try:
            corrupted = _find_corrupted_tasks(vault_root)
            if corrupted:
                all_warnings.append(
                    f"{prefix}\u26a1 {len(corrupted)} подозрительно малых task-файла: "
                    f"{', '.join(corrupted[:5])}"
                )
                total_corrupted += len(corrupted)
        except Exception:
            pass

    # ── Nothing to report → stay silent ──────────────────────────────────
    if not all_actions and not all_warnings:
        return

    # ── Haiku ─────────────────────────────────────────────────────────────
    stats = {
        "orphaned_tmp_deleted": orphan_tmp,
        "journal_rotations": sum(1 for a in all_actions if "Журнал" in a),
        "learning_log_archived": sum(1 for a in all_actions if "Learning Log" in a),
        "orphaned_role_outputs": total_orphans,
        "stale_done_tasks": total_stale,
        "corrupted_task_files": total_corrupted,
        "vaults_scanned": len(vault_roots),
    }
    score = _health_score(total_orphans, total_stale, total_corrupted)
    haiku_text = _haiku_report(stats)

    # ── Print report ──────────────────────────────────────────────────────
    out: List[str] = ["", _SEP, "\U0001f5d1\ufe0f  Vault Janitor", ""]

    if all_actions:
        out.append("\u2705 \u0412\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e:")
        for a in all_actions:
            out.append(f"   \u00b7 {a}")
        out.append("")

    if all_warnings:
        out.append("\u26a0\ufe0f  \u041d\u0430\u0439\u0434\u0435\u043d\u043e:")
        for w in all_warnings:
            out.append(f"   \u00b7 {w}")
        out.append("")

    if haiku_text:
        out.append(f"\U0001f916 {haiku_text}")
        out.append("")

    out.append(f"Score: {score}/100")
    out.append(_SEP)
    out.append("")

    print("\n".join(out))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # Never crash the Stop hook
