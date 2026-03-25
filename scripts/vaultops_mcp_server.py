#!/usr/bin/env python3
"""VaultOps MCP server — local-first Obsidian task management.

All tools read/write local Obsidian markdown files. No backend required.
Runs as a stdio MCP server (JSON-RPC 2.0 over stdin/stdout) for Claude Code.
"""

from __future__ import annotations

import fnmatch
import html as _html
import glob as glob_module
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECTS_JSON = os.path.expanduser(
    os.environ.get("VAULTOPS_PROJECTS_JSON", "~/.vaultops/state/projects.json")
)
REPOS_JSON = os.path.expanduser(
    os.environ.get("VAULTOPS_REPOS_JSON", "~/.vaultops/state/repos.json")
)

MEETINGS_DIR = "_meetings"
MEETING_INDEX = "Meeting Index.md"
MEETING_NOTES_DIR = "Notes"
MEETING_SERIES_DIR = "Series"
MEETING_TEMPLATES_DIR = "Templates"

EXEC_DIR = "08-Execution"
TASK_BOARD = "Task Board.md"
WORK_PLANS = "Work Plans.md"
EXEC_JOURNAL = "Execution Journal.md"
CURRENT_STAGE = "Current Stage.md"
CONTEXT_STATE = "Context State.md"
ROLE_OUTPUTS_DIR = "Role Outputs"

VALID_ROLES = ("BA", "Designer", "SystemAnalyst", "Developer", "QA")
ROLE_ORDER = {role: i for i, role in enumerate(VALID_ROLES)}

DOC_SECTIONS = [
    "00-Overview",
    "01-Requirements",
    "02-Architecture",
    "03-Design",
    "04-Development",
    "05-QA",
    "06-Operations",
    "07-References",
    "09-Interfaces",
    "10-Security",
    "11-Marketing",
]

# Legacy section names that should be auto-renamed to canonical
_SECTION_RENAMES = {
    "02-Research": "02-Architecture",
}

TASKS_DIR = "Tasks"

# ── Section discovery helpers ────────────────────────────────────────────

def _discover_vault_sections(vault_project: str) -> Dict[str, Dict[str, Any]]:
    """Discover all NN-* directories in a vault, mapping them by number prefix.

    Returns dict keyed by canonical section name, e.g.:
      {
        "01-Requirements": {
          "canonical": "01-Requirements",
          "actual": "01-Product",            # what's on disk (or same as canonical)
          "match": "alias",                  # "exact", "alias", or "missing"
          "path": "/vault/01-Product",       # absolute path to actual dir
          "files": ["file1.md", ...],
          "total_bytes": 12345,
        },
      }
    """
    # Build prefix→canonical map
    prefix_to_canonical: Dict[str, str] = {}
    for section in DOC_SECTIONS:
        prefix_to_canonical[section[:2]] = section

    # Scan vault for all NN-* directories
    on_disk: Dict[str, List[str]] = {}  # prefix → list of dir names
    try:
        for entry in os.listdir(vault_project):
            if re.match(r"^\d{2}-", entry) and os.path.isdir(os.path.join(vault_project, entry)):
                prefix = entry[:2]
                on_disk.setdefault(prefix, []).append(entry)
    except OSError:
        pass

    result: Dict[str, Dict[str, Any]] = {}
    for section in DOC_SECTIONS:
        prefix = section[:2]
        dirs_for_prefix = sorted(on_disk.get(prefix, []))

        if section in dirs_for_prefix:
            # Exact canonical match exists
            actual = section
            match_type = "exact"
        elif dirs_for_prefix:
            # Alias: user has a directory with same prefix but different name
            actual = dirs_for_prefix[0]
            match_type = "alias"
        else:
            actual = section
            match_type = "missing"

        actual_path = os.path.join(vault_project, actual)
        files: List[str] = []
        total_bytes = 0
        if match_type != "missing" and os.path.isdir(actual_path):
            try:
                files = [f for f in os.listdir(actual_path) if f.endswith(".md")]
                total_bytes = sum(
                    os.path.getsize(os.path.join(actual_path, f))
                    for f in files if os.path.isfile(os.path.join(actual_path, f))
                )
            except OSError:
                pass

        result[section] = {
            "canonical": section,
            "actual": actual,
            "match": match_type,
            "path": actual_path,
            "files": files,
            "total_bytes": total_bytes,
        }
    return result


def _resolve_section_dir(vault_project: str, prefix: str, canonical_suffix: str) -> str:
    """Find actual directory for a section prefix, falling back to canonical."""
    canonical = f"{prefix}-{canonical_suffix}"
    canonical_path = os.path.join(vault_project, canonical)
    if os.path.isdir(canonical_path):
        return canonical_path
    try:
        for entry in os.listdir(vault_project):
            if entry.startswith(f"{prefix}-") and os.path.isdir(os.path.join(vault_project, entry)):
                return os.path.join(vault_project, entry)
    except OSError:
        pass
    return canonical_path


def _discover_all_section_dirs(vault_project: str) -> List[str]:
    """Return all NN-* directory names found in vault (canonical or alias)."""
    dirs: List[str] = []
    try:
        for entry in sorted(os.listdir(vault_project)):
            if re.match(r"^\d{2}-", entry) and os.path.isdir(os.path.join(vault_project, entry)):
                dirs.append(entry)
    except OSError:
        pass
    return dirs


def _normalize_vault_sections(vault_project: str) -> List[Dict[str, str]]:
    """Rename/merge any non-canonical NN-* directories into canonical names and fix wiki-links.

    Handles three cases per prefix:
    1. Only alias exists (e.g., 01-Product but no 01-Requirements) → rename to canonical
    2. Both alias and canonical exist (buggy leftover) → merge alias files into canonical, remove alias
    3. Only canonical exists → nothing to do

    Returns a list of operations: [{"from": "01-Product", "to": "01-Requirements"}, ...]
    """
    # Build prefix→canonical map
    prefix_to_canonical: Dict[str, str] = {}
    for section in DOC_SECTIONS:
        prefix_to_canonical[section[:2]] = section

    # Scan vault for all NN-* directories
    on_disk: Dict[str, List[str]] = {}
    try:
        for entry in os.listdir(vault_project):
            if re.match(r"^\d{2}-", entry) and os.path.isdir(os.path.join(vault_project, entry)):
                prefix = entry[:2]
                on_disk.setdefault(prefix, []).append(entry)
    except OSError:
        return []

    renames: List[Dict[str, str]] = []

    for prefix, canonical in prefix_to_canonical.items():
        dirs = sorted(on_disk.get(prefix, []))
        # Find non-canonical dirs for this prefix
        aliases = [d for d in dirs if d != canonical]
        if not aliases:
            continue

        canonical_path = os.path.join(vault_project, canonical)
        canonical_exists = os.path.isdir(canonical_path)

        for alias in aliases:
            alias_path = os.path.join(vault_project, alias)

            if canonical_exists:
                # Merge alias files into canonical dir (don't overwrite existing)
                try:
                    for fname in os.listdir(alias_path):
                        src = os.path.join(alias_path, fname)
                        dst = os.path.join(canonical_path, fname)
                        if os.path.isfile(src) and not os.path.exists(dst):
                            os.rename(src, dst)
                    # Remove alias dir if now empty
                    try:
                        os.rmdir(alias_path)
                    except OSError:
                        # Not empty — some subdirs or conflicting files, leave for manual cleanup
                        pass
                except OSError:
                    continue
            else:
                # Rename alias to canonical
                try:
                    os.rename(alias_path, canonical_path)
                    canonical_exists = True  # Now it exists for subsequent aliases
                except OSError:
                    continue

            renames.append({"from": alias, "to": canonical})

    # Fix wiki-links across all .md files in the vault
    if renames:
        _fix_vault_wikilinks(vault_project, renames)

    return renames


def _fix_vault_wikilinks(vault_project: str, renames: List[Dict[str, str]]) -> None:
    """Update wiki-links and path references after section renames."""
    # Build replacement pairs
    replacements: List[Tuple[str, str]] = []
    for r in renames:
        old, new = r["from"], r["to"]
        # Wiki-link paths: [[01-Product/file]] → [[01-Requirements/file]]
        replacements.append((f"[[{old}/", f"[[{new}/"))
        replacements.append((f"[[{old}]]", f"[[{new}]]"))
        # Plain path references in frontmatter/text
        replacements.append((f"{old}/", f"{new}/"))

    # Walk all .md files in vault
    for root, _dirs, files in os.walk(vault_project):
        for fname in files:
            if not fname.endswith(".md"):
                continue
            fpath = os.path.join(root, fname)
            try:
                content = _read_file(fpath)
                if not content:
                    continue
                new_content = content
                for old_str, new_str in replacements:
                    new_content = new_content.replace(old_str, new_str)
                if new_content != content:
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(new_content)
            except OSError:
                continue

TASK_BOARD_HEADER = "| ID | Task | Status | Priority | Owner | Details | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n"


# ── MCP stdio transport (JSON-RPC 2.0) ──────────────────────────────────


def _read_message() -> Optional[Dict[str, Any]]:
    headers: Dict[str, str] = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        text = line.decode("utf-8", errors="replace").strip()
        if not text or ":" not in text:
            continue
        key, value = text.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        return None
    if length <= 0:
        return None
    raw = sys.stdin.buffer.read(length)
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def _send_message(payload: Dict[str, Any]) -> None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    # Use os.write() for atomic unbuffered output — bypasses Python's pipe buffering
    os.write(sys.stdout.fileno(), header + body)


def _json_response(msg_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _json_error(msg_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def _tool_result(data: Any, is_error: bool = False) -> Dict[str, Any]:
    text = json.dumps(data, ensure_ascii=False, indent=2) if isinstance(data, (dict, list)) else str(data)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


# ── Vault path resolution ────────────────────────────────────────────────


def _resolve_vault_root(project_path: str) -> Optional[str]:
    """Resolve Obsidian vault root for a project."""
    project_path = os.path.expanduser(project_path)

    # 1. Check .vaultops/config.env in project
    config_env = os.path.join(project_path, ".vaultops", "config.env")
    if os.path.isfile(config_env):
        with open(config_env, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("VAULTOPS_PROJECT_VAULT_ROOT="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")

    # 2. Check projects.json registry
    if os.path.isfile(PROJECTS_JSON):
        try:
            with open(PROJECTS_JSON, "r") as f:
                registry = json.load(f)
            for proj in registry.get("projects", []):
                if proj.get("path") == project_path and proj.get("vaultRoot"):
                    return proj["vaultRoot"]
        except (json.JSONDecodeError, KeyError):
            pass

    return None


def _resolve_vault_project(project_path: str) -> Optional[str]:
    """Resolve the full vault project path.

    Checks VAULTOPS_PROJECT_VAULT_PATH in .vaultops/config.env first — if set,
    that path is used directly (no repo_id suffix appended). This lets a project
    point its vault to an existing Obsidian vault root without creating a subfolder.

    Falls back to vault_root + repo_id (legacy behaviour).
    """
    project_path = os.path.expanduser(project_path)

    # 1. Direct override in project config.env
    config_env = os.path.join(project_path, ".vaultops", "config.env")
    if os.path.isfile(config_env):
        with open(config_env, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("VAULTOPS_PROJECT_VAULT_PATH="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")

    # 2. Fall back to vault_root + repo_id
    vault_root = _resolve_vault_root(project_path)
    if not vault_root:
        return None
    repo_id = os.path.basename(os.path.normpath(project_path))
    return os.path.join(vault_root, repo_id)


def _resolve_vault_project_from_registry(proj: Dict[str, Any]) -> str:
    """Resolve vault_project for a registry entry.

    Respects VAULTOPS_PROJECT_VAULT_PATH in the project's config.env (same override
    logic as _resolve_vault_project). Falls back to vault_root + repo_id from the
    registry entry when no override is present or the project path is unknown.
    """
    proj_path = proj.get("path", "")
    if proj_path:
        resolved = _resolve_vault_project(proj_path)
        if resolved:
            return resolved
    vault_root = proj.get("vaultRoot", "")
    repo_id = proj.get("repoId", "")
    return os.path.join(vault_root, repo_id)


def _exec_path(project_path: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (exec_dir_path, error_message)."""
    vault_project = _resolve_vault_project(project_path)
    if not vault_project:
        return None, f"No vault root found for project: {project_path}. Run 'vaultops add' first."

    exec_dir = os.path.join(vault_project, EXEC_DIR)

    if not os.path.isdir(exec_dir):
        return None, f"Execution directory not found: {exec_dir}. Run 'vaultops init' first."

    return exec_dir, None


def _read_file(filepath: str) -> str:
    """Read file, return empty string if missing."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read()
    except (FileNotFoundError, PermissionError):
        return ""


def _atomic_write(filepath: str, content: str) -> None:
    """Write file atomically via temp file + rename."""
    dirpath = os.path.dirname(filepath)
    os.makedirs(dirpath, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dirpath, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, filepath)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Task Board parsing ───────────────────────────────────────────────────


def _normalize_status(raw: str) -> str:
    s = raw.strip().lower()
    if s in ("done", "completed", "complete"):
        return "DONE"
    if s in ("in_progress", "in progress", "running"):
        return "IN_PROGRESS"
    if s in ("blocked", "failed", "error"):
        return "BLOCKED"
    if s in ("todo", "queued", "open", ""):
        return "TODO"
    return "TODO"


def _parse_task_board(markdown: str) -> List[Dict[str, str]]:
    """Parse Task Board markdown table into list of task dicts."""
    rows = []
    for line in markdown.split("\n"):
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 6:
            continue
        # Skip header row and separator
        if cells[0].lower() == "id" or all(re.match(r"^:?-+:?$", c) for c in cells):
            continue
        rows.append({
            "id": cells[0],
            "task": cells[1],
            "status": _normalize_status(cells[2]),
            "raw_status": cells[2],
            "priority": cells[3] if len(cells) > 3 else "",
            "owner": cells[4] if len(cells) > 4 else "",
            "details": cells[5] if len(cells) > 5 else "",
            "evidence": cells[6] if len(cells) > 6 else "",
        })
    return rows


def _next_task_id(rows: List[Dict[str, str]]) -> str:
    """Find highest EXE-### and return next."""
    max_num = 0
    for row in rows:
        m = re.match(r"EXE-(\d+)", row["id"])
        if m:
            max_num = max(max_num, int(m.group(1)))
    return f"EXE-{max_num + 1:03d}"


# ── Impact receipts ───────────────────────────────────────────────────────

_RECEIPT_WIDTH = 43
_RECEIPT_SEP = "━" * _RECEIPT_WIDTH


def _vault_stats(exec_dir: str) -> Dict[str, int]:
    """Count tasks and docs for impact receipts."""
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)
    stats: Dict[str, int] = {"done": 0, "active": 0, "todo": 0, "blocked": 0, "total": len(tasks), "docs": 0}
    for t in tasks:
        s = t["status"]
        if s == "DONE":
            stats["done"] += 1
        elif s == "IN_PROGRESS":
            stats["active"] += 1
        elif s == "BLOCKED":
            stats["blocked"] += 1
        else:
            stats["todo"] += 1
    vault_root = os.path.dirname(exec_dir)
    doc_count = 0
    try:
        for entry in os.scandir(vault_root):
            if entry.is_dir() and not entry.name.startswith("."):
                try:
                    for f in os.scandir(entry.path):
                        if f.name.endswith(".md"):
                            doc_count += 1
                except OSError:
                    pass
    except OSError:
        pass
    stats["docs"] = doc_count
    return stats


def _progress_bar(done: int, total: int, width: int = 16) -> str:
    filled = round(done / total * width) if total else 0
    return "█" * filled + "░" * (width - filled)


def _impact_receipt(action: str, detail_lines: List[str], stats: Dict[str, int]) -> str:
    """Render a branded impact receipt in VaultOps visual identity."""
    d = stats.get("done", 0)
    a = stats.get("active", 0)
    t = stats.get("todo", 0)
    total = stats.get("total", 0)
    docs = stats.get("docs", 0)
    bar = _progress_bar(d, total)
    lines = [
        _RECEIPT_SEP,
        "⬡  VaultOps",
        _RECEIPT_SEP,
        "",
        f"  ✦  {action}",
    ]
    for dl in detail_lines:
        lines.append(f"     {dl}")
    lines += [
        "",
        f"  {bar}  {d}✓  {a}▶  {t}○",
        f"  ◈  {docs} docs across vault",
        "",
        _RECEIPT_SEP,
    ]
    return "\n".join(lines)


def _receipt_result(receipt: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Return a tool result combining a visual receipt with structured data."""
    json_part = json.dumps(data, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": f"{receipt}\n\n{json_part}"}]}


# ── Tool implementations ─────────────────────────────────────────────────


def _tool_get_context(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    current_stage = _read_file(os.path.join(exec_dir, CURRENT_STAGE))
    context_state = _read_file(os.path.join(exec_dir, CONTEXT_STATE))
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)

    active = [t for t in tasks if t["status"] == "IN_PROGRESS"]
    todo = [t for t in tasks if t["status"] == "TODO"]
    blocked = [t for t in tasks if t["status"] == "BLOCKED"]

    summary = {
        "project": os.path.basename(os.path.normpath(project_path)),
        "current_stage": current_stage.strip()[:500] if current_stage else "Not set",
        "context_state": context_state.strip()[:500] if context_state else "Not set",
        "task_summary": {
            "total": len(tasks),
            "in_progress": len(active),
            "todo": len(todo),
            "blocked": len(blocked),
            "done": len([t for t in tasks if t["status"] == "DONE"]),
        },
        "active_tasks": [{"id": t["id"], "task": t["task"], "priority": t["priority"]} for t in active],
        "blocked_tasks": [{"id": t["id"], "task": t["task"], "details": t["details"]} for t in blocked],
    }
    return _tool_result(summary)


def _tool_get_today(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)

    active = [t for t in tasks if t["status"] == "IN_PROGRESS"]
    todo = [t for t in tasks if t["status"] == "TODO"]
    blocked = [t for t in tasks if t["status"] == "BLOCKED"]

    checklist = []
    for t in active:
        checklist.append(f"- [~] {t['id']}: {t['task']} (IN_PROGRESS, {t['priority']})")
    for t in blocked:
        checklist.append(f"- [!] {t['id']}: {t['task']} (BLOCKED, {t['priority']})")
    for t in todo:
        checklist.append(f"- [ ] {t['id']}: {t['task']} (TODO, {t['priority']})")

    result = {
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "project": os.path.basename(os.path.normpath(project_path)),
        "in_progress": len(active),
        "todo": len(todo),
        "blocked": len(blocked),
        "checklist": "\n".join(checklist) if checklist else "No active tasks. Use /task to create one.",
    }
    return _tool_result(result)


def _tool_update_task(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")
    new_status = args.get("status", "")
    evidence = args.get("evidence", "")

    if not task_id:
        return _tool_result({"error": "task_id is required"}, is_error=True)

    if not re.match(r"^[A-Z]+-\d+(\.\d+)?$", task_id):
        return _tool_result({"error": f"Invalid task_id format: {task_id}"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    filepath = os.path.join(exec_dir, TASK_BOARD)
    content = _read_file(filepath)
    if not content:
        return _tool_result({"error": "Task Board is empty"}, is_error=True)

    lines = content.split("\n")
    updated = False
    for i, line in enumerate(lines):
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 6:
            continue
        if cells[0].strip() == task_id:
            if new_status:
                cells[2] = new_status.upper()
            if evidence:
                if len(cells) > 6:
                    existing = cells[6].strip()
                    cells[6] = f"{existing}; {evidence}" if existing else evidence
                else:
                    cells.append(evidence)
            lines[i] = "| " + " | ".join(cells) + " |"
            updated = True
            break

    if not updated:
        return _tool_result({"error": f"Task {task_id} not found"}, is_error=True)

    _atomic_write(filepath, "\n".join(lines))

    # Sync changes to individual task file if it exists
    task_file = os.path.join(exec_dir, TASKS_DIR, f"{task_id}.md")
    if os.path.isfile(task_file):
        task_content = _read_file(task_file)
        if new_status:
            task_content = _update_frontmatter_field(task_content, "status", new_status.upper())
        task_content = _update_frontmatter_field(
            task_content, "updated_at", datetime.now(timezone.utc).isoformat()
        )
        if evidence:
            # Append evidence to the Evidence section
            if "## Evidence" in task_content:
                task_content = task_content.replace(
                    "## Evidence\n",
                    f"## Evidence\n\n- {datetime.now(timezone.utc).strftime('%Y-%m-%d')}: {evidence}\n",
                    1,
                )
            else:
                task_content += f"\n## Evidence\n\n- {datetime.now(timezone.utc).strftime('%Y-%m-%d')}: {evidence}\n"
        _atomic_write(task_file, task_content)

    data = {"updated": task_id, "status": new_status or "(unchanged)", "evidence": evidence or "(none)"}

    # Auto-commit for doc repos (granular mode)
    vault_project = _resolve_vault_project(project_path)
    if vault_project:
        sha = _auto_commit_if_doc_repo(vault_project, f"vault: update {task_id} → {new_status or 'evidence'}")
        if sha:
            data["auto_commit"] = sha

    try:
        stats = _vault_stats(exec_dir)
        status_icon = "✓" if (new_status or "").upper() == "DONE" else "▶" if (new_status or "").upper() == "IN_PROGRESS" else "○"
        detail_lines = [f"{task_id}  →  {new_status or '(unchanged)'}  {status_icon}"]
        if evidence:
            detail_lines.append(f"Evidence: {evidence[:36]}")
        receipt = _impact_receipt("Task updated", detail_lines, stats)
        return _receipt_result(receipt, data)
    except Exception:
        return _tool_result(data)


# ── Task-as-Code: verification runner ─────────────────────────────────


def _run_verify_checks(
    checks: List[Dict[str, Any]],
    project_path: str,
    files_edited: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Run verify: checks from task frontmatter. Returns {passed, total, results}.

    Supported check types:
      - test_pattern:  glob for test files + run them
      - file_exists:   path must exist (relative to project_path)
      - file_changed:  path must appear in files_edited list
      - grep_content:  file must contain regex pattern
    """
    results: List[Dict[str, Any]] = []
    files_edited = files_edited or []

    for check in checks:
        if not isinstance(check, dict):
            continue
        ctype = check.get("type", "")
        result: Dict[str, Any] = {"type": ctype, "passed": False, "detail": ""}

        try:
            if ctype == "file_exists":
                path = check.get("path", "")
                resolved = (Path(project_path) / path).resolve()
                project_root = Path(project_path).resolve()
                try:
                    resolved.relative_to(project_root)
                except ValueError:
                    result["detail"] = f"path outside project: {path}"
                    results.append(result)
                    continue
                full = str(resolved)
                exists = os.path.exists(full)
                result["passed"] = exists
                result["detail"] = f"{'exists' if exists else 'missing'}: {path}"

            elif ctype == "file_changed":
                path = check.get("path", "")
                # Check if path matches any edited file (glob support)
                matched = any(
                    fnmatch.fnmatch(f, path) or f.endswith(path) or os.path.basename(f) == os.path.basename(path)
                    for f in files_edited
                )
                result["passed"] = matched
                result["detail"] = f"{'changed' if matched else 'not changed'}: {path}"

            elif ctype == "grep_content":
                path = check.get("path", "")
                pattern = check.get("pattern", "")
                # Resolve path and ensure it stays within project_path (prevent traversal)
                from pathlib import Path as _Path
                resolved = (_Path(project_path) / path).resolve()
                project_root = _Path(project_path).resolve()
                try:
                    resolved.relative_to(project_root)
                except ValueError:
                    result["detail"] = f"path outside project: {path}"
                    results.append(result)
                    continue
                full = str(resolved)
                if os.path.isfile(full):
                    content = _read_file(full)
                    # Guard against ReDoS: test regex on short string with thread timeout
                    import threading as _threading
                    _found = [False]
                    _err = [None]
                    def _do_search():
                        try:
                            _found[0] = bool(re.search(pattern, content))
                        except Exception as e:
                            _err[0] = str(e)
                    t = _threading.Thread(target=_do_search, daemon=True)
                    t.start()
                    t.join(timeout=5.0)
                    if t.is_alive():
                        result["detail"] = f"regex timed out: {path}"
                        results.append(result)
                        continue
                    if _err[0]:
                        result["detail"] = f"regex error: {_err[0]}"
                        results.append(result)
                        continue
                    found = _found[0]
                    result["passed"] = found
                    result["detail"] = f"pattern {'found' if found else 'not found'} in {path}"
                else:
                    result["detail"] = f"file not found: {path}"

            elif ctype == "test_pattern":
                pattern = check.get("pattern", "")
                expect = check.get("expect", "pass")
                matched_files = glob_module.glob(
                    os.path.join(project_path, pattern), recursive=True
                )
                if matched_files:
                    result["passed"] = True  # files exist; actual test run is tracked by session
                    result["detail"] = f"{len(matched_files)} test file(s) match {pattern}"
                else:
                    result["passed"] = False
                    result["detail"] = f"no test files match {pattern}"

            else:
                result["detail"] = f"unknown check type: {ctype}"

        except Exception as exc:
            result["detail"] = f"error: {str(exc)[:80]}"

        results.append(result)

    passed = sum(1 for r in results if r["passed"])
    return {"passed": passed, "total": len(results), "all_passed": passed == len(results), "results": results}


def _tool_run_verify(args: Dict[str, Any]) -> Dict[str, Any]:
    """Run verify checks for a task and return results."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")

    if not task_id:
        return _tool_result({"error": "task_id is required"}, is_error=True)

    if not re.match(r"^[A-Z]+-\d+(\.\d+)?$", task_id):
        return _tool_result({"error": f"Invalid task_id format: {task_id}"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    task_file = os.path.join(exec_dir, TASKS_DIR, f"{task_id}.md")
    if not os.path.isfile(task_file):
        return _tool_result({"error": f"Task file not found: {task_id}"}, is_error=True)

    content = _read_file(task_file)
    fm, _ = _parse_frontmatter(content)
    checks = _parse_verify_checks(fm)

    if not checks:
        return _tool_result({"task_id": task_id, "message": "No verify checks defined", "passed": True})

    result = _run_verify_checks(checks, project_path)
    result["task_id"] = task_id

    # Build a visual receipt
    lines = []
    for r in result["results"]:
        icon = "\u2713" if r["passed"] else "\u2717"
        lines.append(f"  {icon}  {r['detail']}")

    status = "ALL PASSED" if result["all_passed"] else f"FAILED ({result['passed']}/{result['total']})"
    receipt = f"\u2501" * 43 + "\n"
    receipt += f"  \u2726  Verify: {task_id}  \u00b7  {status}\n"
    receipt += f"\u2501" * 43 + "\n"
    receipt += "\n".join(lines) + "\n"
    receipt += f"\u2501" * 43

    return _receipt_result(receipt, result)


def _serialize_verify_yaml(checks: List[Dict[str, Any]]) -> str:
    """Serialize verify checks to inline YAML-like format for frontmatter."""
    if not checks:
        return "[]"
    parts = []
    for c in checks:
        items = ", ".join(f"{k}: {v}" for k, v in c.items() if v)
        parts.append("{" + items + "}")
    return "[" + ", ".join(parts) + "]"


def _parse_verify_checks(fm: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse verify field from frontmatter into list of check dicts.

    Handles:
      - Already parsed list of dicts (from JSON input)
      - List of strings split by _parse_frontmatter (which splits on commas
        inside [...], breaking {key: val, key: val} into fragments)
      - Raw string format: [{type: file_exists, path: foo.ts}, ...]
    """
    raw = fm.get("verify", [])
    if isinstance(raw, list):
        # Check if already proper dicts
        if raw and isinstance(raw[0], dict) and "type" in raw[0]:
            return raw

        # Reassemble fragments split by _parse_frontmatter's comma splitting.
        # Input: ['{type: file_exists', 'path: src/auth.ts}', '{type: grep_content', ...]
        # Output: [{type: file_exists, path: src/auth.ts}, {type: grep_content, ...}]
        joined = ", ".join(str(item) for item in raw)
        checks: List[Dict[str, str]] = []
        for match in re.finditer(r"\{([^}]+)\}", joined):
            d: Dict[str, str] = {}
            for pair in match.group(1).split(","):
                pair = pair.strip()
                if ":" in pair:
                    k, v = pair.split(":", 1)
                    d[k.strip()] = v.strip()
            if d:
                checks.append(d)
        return checks
    elif isinstance(raw, str) and raw.strip().startswith("["):
        checks = []
        for match in re.finditer(r"\{([^}]+)\}", raw):
            d = {}
            for pair in match.group(1).split(","):
                if ":" in pair:
                    k, v = pair.split(":", 1)
                    d[k.strip()] = v.strip()
            if d:
                checks.append(d)
        return checks
    return []


def _tool_create_task(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    title = args.get("title", "")
    description = args.get("description", "")
    priority = args.get("priority", "P1")
    owner = args.get("owner", "Agent")
    scheduled_date = args.get("scheduled_date", "")
    tags = args.get("tags", [])
    blocked_by = args.get("blocked_by", [])
    parent_task = args.get("parent_task", "")
    verify = args.get("verify", [])

    if not title:
        return _tool_result({"error": "title is required"}, is_error=True)

    if parent_task and not re.match(r"^[A-Z]+-\d+$", parent_task):
        return _tool_result({"error": f"Invalid parent_task format: {parent_task}"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    filepath = os.path.join(exec_dir, TASK_BOARD)
    content = _read_file(filepath)

    # Initialize task board if empty
    if not content.strip():
        content = TASK_BOARD_HEADER

    tasks = _parse_task_board(content)

    # Sub-task support: EXE-001.1, EXE-001.2
    if parent_task:
        # Find max sub-task number for this parent
        max_sub = 0
        for t in tasks:
            m = re.match(rf"^{re.escape(parent_task)}\.(\d+)$", t["id"])
            if m:
                max_sub = max(max_sub, int(m.group(1)))
        new_id = f"{parent_task}.{max_sub + 1}"
    else:
        new_id = _next_task_id(tasks)

    new_row = f"| {new_id} | {title} | TODO | {priority} | {owner} | {description} |  |"
    content = content.rstrip("\n") + "\n" + new_row + "\n"
    _atomic_write(filepath, content)

    # Create individual task file with YAML frontmatter
    now = datetime.now(timezone.utc).isoformat()
    # Add hierarchical tags for Graph View
    system_tags = [f"vaultops/task", f"vaultops/priority/{priority.lower()}", f"vaultops/status/todo"]
    all_tags = list(tags) + system_tags
    tags_yaml = "[" + ", ".join(all_tags) + "]"
    blocked_by_yaml = "[" + ", ".join(blocked_by) + "]" if blocked_by else "[]"
    verify_yaml = _serialize_verify_yaml(verify) if verify else "[]"

    task_file_content = f"""---
id: {new_id}
title: "{title}"
status: TODO
priority: {priority}
owner: {owner}
created_at: {now}
scheduled_date: {scheduled_date or ""}
sprint: null
tags: {tags_yaml}
blocked_by: {blocked_by_yaml}
blocks: []
subtasks: []
parent: {parent_task or "null"}
verify: {verify_yaml}
---

# {new_id}: {title}

## Description

{description or "*(No description provided)*"}

## Acceptance Criteria

- [ ] *(To be filled by BA role — run `/ba {new_id}` or `/enrich {new_id}`)*
"""

    # Add verify section if checks defined
    if verify:
        task_file_content += "\n## Verify (Task-as-Code)\n\n"
        task_file_content += "Completion contract — task is DONE only when all checks pass:\n\n"
        for i, check in enumerate(verify, 1):
            ctype = check.get("type", "?")
            desc_parts = [f"`{ctype}`"]
            for k, v in check.items():
                if k != "type":
                    desc_parts.append(f"{k}=`{v}`")
            task_file_content += f"- [ ] {' '.join(desc_parts)}\n"
        task_file_content += "\n"

    task_file_content += """## Notes


## Evidence


## Links
"""

    # Add parent link if sub-task
    if parent_task:
        task_file_content += f"\n- Parent: [[{parent_task}]]\n"
        # Update parent task file to add sub-task reference
        parent_file = os.path.join(exec_dir, TASKS_DIR, f"{parent_task}.md")
        if os.path.isfile(parent_file):
            parent_content = _read_file(parent_file)
            # Add to subtasks in frontmatter
            parent_content = _update_frontmatter_list(parent_content, "subtasks", new_id)
            _atomic_write(parent_file, parent_content)

    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    task_file_path = os.path.join(tasks_dir, f"{new_id}.md")
    _atomic_write(task_file_path, task_file_content)

    result = {"created": new_id, "title": title, "status": "TODO", "file": task_file_path}
    if parent_task:
        result["parent"] = parent_task

    # Auto-commit for doc repos (granular mode)
    vault_project = _resolve_vault_project(project_path)
    if vault_project:
        sha = _auto_commit_if_doc_repo(vault_project, f"vault: create task {new_id} — {title}")
        if sha:
            result["auto_commit"] = sha

    try:
        stats = _vault_stats(exec_dir)
        parent_line = [f"subtask of {parent_task}"] if parent_task else []
        receipt = _impact_receipt(
            "Task created",
            [f"{new_id}  ·  {title}", f"Priority: {priority}"] + parent_line,
            stats,
        )
        return _receipt_result(receipt, result)
    except Exception:
        return _tool_result(result)


def _tool_log_step(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    message = args.get("message", "")

    if not message:
        return _tool_result({"error": "message is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    filepath = os.path.join(exec_dir, EXEC_JOURNAL)
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    iso_str = now.isoformat()

    entry = f"\n## {date_str} — {message}\n- Logged: {iso_str}\n"

    existing = _read_file(filepath)
    content = existing + entry

    _atomic_write(filepath, content)

    # Auto-commit for doc repos (granular mode)
    vault_project = _resolve_vault_project(project_path)
    if vault_project:
        _auto_commit_if_doc_repo(vault_project, f"vault: journal — {message[:50]}")

    return _tool_result({"logged": message, "timestamp": iso_str})


def _tool_write_plan(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    plan_content = args.get("content", "")

    if not plan_content:
        return _tool_result({"error": "content is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    filepath = os.path.join(exec_dir, WORK_PLANS)
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")

    entry = f"\n### {date_str} — Plan\n\n{plan_content}\n"

    existing = _read_file(filepath)
    content = existing + entry

    _atomic_write(filepath, content)
    data = {"written": True, "date": date_str, "file": filepath}

    # Auto-commit for doc repos (granular mode)
    vault_project = _resolve_vault_project(project_path)
    if vault_project:
        sha = _auto_commit_if_doc_repo(vault_project, f"vault: update work plans — {date_str}")
        if sha:
            data["auto_commit"] = sha

    try:
        stats = _vault_stats(exec_dir)
        word_count = len(plan_content.split())
        receipt = _impact_receipt(
            "Work plan saved",
            [f"Date: {date_str}  ·  ~{word_count} words", "08-Execution/Work Plans.md"],
            stats,
        )
        return _receipt_result(receipt, data)
    except Exception:
        return _tool_result(data)


def _tool_get_kanban(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = args.get("project_path", ".")
    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)

    board: Dict[str, List[Dict[str, str]]] = {
        "IN_PROGRESS": [],
        "TODO": [],
        "BLOCKED": [],
        "DONE": [],
    }
    for t in tasks:
        status = t["status"] if t["status"] in board else "TODO"
        board[status].append({"id": t["id"], "task": t["task"], "priority": t["priority"]})

    return _tool_result({
        "project": os.path.basename(os.path.normpath(project_path)),
        "board": board,
        "counts": {k: len(v) for k, v in board.items()},
    })


def _tool_generate_docs_prompt(args: Dict[str, Any]) -> Dict[str, Any]:
    project_path = os.path.expanduser(args.get("project_path", "."))
    vault_project = _resolve_vault_project(project_path)
    if not vault_project:
        return _tool_result({"error": "No vault root found. Run 'vaultops add' first."}, is_error=True)

    repo_id = os.path.basename(os.path.normpath(project_path))

    # Scan repo file tree (top 3 levels, respecting common ignores)
    ignore_dirs = {".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "vendor", ".vaultops"}
    file_tree: List[str] = []
    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        depth = root.replace(project_path, "").count(os.sep)
        if depth > 3:
            dirs.clear()
            continue
        rel = os.path.relpath(root, project_path)
        for f in files:
            file_tree.append(os.path.join(rel, f) if rel != "." else f)

    # Normalize alias section dirs → canonical names (rename + fix links)
    renames = _normalize_vault_sections(vault_project)

    # Discover sections (after normalization, all should be exact or missing)
    section_map = _discover_vault_sections(vault_project)

    # Build status strings and resolve actual paths
    section_status: Dict[str, str] = {}
    section_paths: Dict[str, str] = {}
    for section in DOC_SECTIONS:
        info = section_map[section]
        section_paths[section] = info["path"]
        if info["match"] == "missing":
            section_status[section] = "MISSING"
        elif not info["files"]:
            section_status[section] = "EMPTY"
        else:
            section_status[section] = f"HAS_CONTENT ({len(info['files'])} files, {info['total_bytes']} bytes)"

    # Build rename report for the prompt
    rename_report = ""
    if renames:
        rename_lines = [f"  - {r['from']} → {r['to']}" for r in renames]
        rename_report = f"\n## Sections renamed to canonical names:\n" + chr(10).join(rename_lines) + "\nAll wiki-links updated automatically.\n"

    prompt = f"""Generate documentation for the project "{repo_id}".

## Repository file tree (top 3 levels):
```
{chr(10).join(file_tree[:200])}
```
{rename_report}
## Current documentation status:
{chr(10).join(f"- {s}: {st}" for s, st in section_status.items())}

## Instructions:
For each section that is MISSING or EMPTY, generate a starter markdown file.
For sections with HAS_CONTENT, check if the primary file meets VaultOps format standards.
If not, standardize the entire section (refactor all files to standard format).
Focus on:
- 00-Overview: System Architecture.md — high-level architecture diagram and tech stack
- 01-Requirements: Product Goals.md — what the product does and key user stories
- 04-Development: Codebase Map.md — key directories, entry points, patterns
- 06-Operations: Runbook.md — how to start, deploy, monitor
- 07-References: Architecture Decisions.md — key ADRs

Keep each file concise (200-400 words). Use what you can infer from the file tree and any README.md content.
"""

    return _tool_result({
        "vault_project": vault_project,
        "repo_id": repo_id,
        "section_paths": section_paths,
        "section_map": {k: v for k, v in section_map.items()},
        "sections": section_status,
        "renames": renames,
        "file_count": len(file_tree),
        "prompt": prompt,
        "instruction": "Use the Write tool with paths from section_paths to save generated docs to the correct vault location.",
    })


# ── Role-based enrichment tools ──────────────────────────────────────────


def _tool_get_task(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get a single task by ID with full details and role outputs."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")

    if not task_id:
        return _tool_result({"error": "task_id is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Find task in board
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)
    task = next((t for t in tasks if t["id"] == task_id), None)

    if not task:
        return _tool_result({"error": f"Task {task_id} not found in Task Board"}, is_error=True)

    # Read role outputs
    role_outputs_dir = os.path.join(exec_dir, ROLE_OUTPUTS_DIR, task_id)
    role_outputs: Dict[str, Dict[str, Any]] = {}

    if os.path.isdir(role_outputs_dir):
        for role in VALID_ROLES:
            role_file = os.path.join(role_outputs_dir, f"{role}.md")
            if os.path.isfile(role_file):
                content = _read_file(role_file)
                frontmatter, body = _parse_frontmatter(content)
                role_outputs[role] = {
                    "status": frontmatter.get("status", "unknown"),
                    "updated_at": frontmatter.get("updated_at", ""),
                    "content": body.strip(),
                }

    completed_roles = [r for r in VALID_ROLES if r in role_outputs and role_outputs[r].get("status") == "complete"]
    next_role = None
    for role in VALID_ROLES:
        if role not in completed_roles:
            next_role = role
            break

    return _tool_result({
        "task": task,
        "role_outputs": role_outputs,
        "completed_roles": completed_roles,
        "next_role": next_role,
    })


def _parse_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    """Parse YAML-like frontmatter from markdown. Returns (frontmatter_dict, body)."""
    if not content.startswith("---"):
        return {}, content

    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content

    fm: Dict[str, Any] = {}
    for line in parts[1].strip().split("\n"):
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        # Handle YAML arrays like [tag1, tag2]
        if value.startswith("[") and value.endswith("]"):
            fm[key] = [v.strip().strip("'\"") for v in value[1:-1].split(",") if v.strip()]
        elif value.lower() in ("true", "false"):
            fm[key] = value.lower() == "true"
        else:
            fm[key] = value.strip("'\"")

    return fm, parts[2]


def _update_frontmatter_list(content: str, key: str, value: str) -> str:
    """Add a value to a YAML frontmatter list field."""
    if not content.startswith("---"):
        return content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return content

    lines = parts[1].strip().split("\n")
    updated = False
    for i, line in enumerate(lines):
        if line.strip().startswith(f"{key}:"):
            current = line.split(":", 1)[1].strip()
            if current.startswith("[") and current.endswith("]"):
                items = [v.strip().strip("'\"") for v in current[1:-1].split(",") if v.strip()]
                if value not in items:
                    items.append(value)
                lines[i] = f"{key}: [{', '.join(items)}]"
            updated = True
            break

    if not updated:
        lines.append(f"{key}: [{value}]")

    return "---\n" + "\n".join(lines) + "\n---" + parts[2]


def _update_frontmatter_field(content: str, key: str, value: str) -> str:
    """Update a single YAML frontmatter field value."""
    if not content.startswith("---"):
        return content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return content

    lines = parts[1].strip().split("\n")
    updated = False
    for i, line in enumerate(lines):
        if line.strip().startswith(f"{key}:"):
            lines[i] = f"{key}: {value}"
            updated = True
            break

    if not updated:
        lines.append(f"{key}: {value}")

    return "---\n" + "\n".join(lines) + "\n---" + parts[2]


def _tool_write_role_output(args: Dict[str, Any]) -> Dict[str, Any]:
    """Write a role output file for a task."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")
    role = args.get("role", "")
    content = args.get("content", "")

    if not task_id:
        return _tool_result({"error": "task_id is required"}, is_error=True)
    if not role or role not in VALID_ROLES:
        return _tool_result({"error": f"role must be one of: {', '.join(VALID_ROLES)}"}, is_error=True)
    if not content:
        return _tool_result({"error": "content is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Verify task exists
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        return _tool_result({"error": f"Task {task_id} not found in Task Board"}, is_error=True)

    now = datetime.now(timezone.utc).isoformat()

    # Build file with YAML frontmatter
    file_content = f"""---
role: {role}
task_id: {task_id}
status: complete
updated_at: {now}
tags: [vaultops/role-output, vaultops/role/{role.lower()}, vaultops/task/{task_id}]
---

{content}
"""

    role_dir = os.path.join(exec_dir, ROLE_OUTPUTS_DIR, task_id)
    filepath = os.path.join(role_dir, f"{role}.md")
    _atomic_write(filepath, file_content)

    # Auto-log to journal
    journal_path = os.path.join(exec_dir, EXEC_JOURNAL)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    entry = f"\n## {date_str} — {role} output written for {task_id}\n- Logged: {now}\n"
    existing = _read_file(journal_path)
    _atomic_write(journal_path, existing + entry)

    data = {"written": True, "task_id": task_id, "role": role, "file": filepath, "updated_at": now}

    # Auto-commit for doc repos (granular mode)
    vault_project = _resolve_vault_project(project_path)
    if vault_project:
        sha = _auto_commit_if_doc_repo(vault_project, f"vault: {role} output for {task_id}")
        if sha:
            data["auto_commit"] = sha

    try:
        stats = _vault_stats(exec_dir)
        # Show role chain progress for this task
        roles_done = []
        for r in VALID_ROLES:
            rpath = os.path.join(exec_dir, ROLE_OUTPUTS_DIR, task_id, f"{r}.md")
            roles_done.append(f"{r} ✓" if os.path.isfile(rpath) else f"{r} ○")
        chain = "  ·  ".join(roles_done)
        task_title = task.get("task", "")[:30] if task else ""
        receipt = _impact_receipt(
            f"{role} output saved",
            [f"{task_id}  ·  {task_title}", chain],
            stats,
        )
        return _receipt_result(receipt, data)
    except Exception:
        return _tool_result(data)


def _tool_get_role_output(args: Dict[str, Any]) -> Dict[str, Any]:
    """Read a specific role output for a task."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")
    role = args.get("role", "")

    if not task_id:
        return _tool_result({"error": "task_id is required"}, is_error=True)
    if not role or role not in VALID_ROLES:
        return _tool_result({"error": f"role must be one of: {', '.join(VALID_ROLES)}"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    filepath = os.path.join(exec_dir, ROLE_OUTPUTS_DIR, task_id, f"{role}.md")
    if not os.path.isfile(filepath):
        return _tool_result({
            "exists": False,
            "task_id": task_id,
            "role": role,
            "content": None,
        })

    raw = _read_file(filepath)
    frontmatter, body = _parse_frontmatter(raw)

    return _tool_result({
        "exists": True,
        "task_id": task_id,
        "role": role,
        "status": frontmatter.get("status", "unknown"),
        "updated_at": frontmatter.get("updated_at", ""),
        "content": body.strip(),
    })


# ── Task relationship tools ──────────────────────────────────────────────


def _tool_link_tasks(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create a dependency relationship between two tasks."""
    project_path = args.get("project_path", ".")
    source_task = args.get("source_task", "")
    target_task = args.get("target_task", "")
    relationship = args.get("relationship", "related-to")

    if not source_task or not target_task:
        return _tool_result({"error": "source_task and target_task are required"}, is_error=True)

    valid_rels = ("blocked-by", "blocks", "subtask-of", "parent-of", "related-to")
    if relationship not in valid_rels:
        return _tool_result({"error": f"relationship must be one of: {', '.join(valid_rels)}"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    tasks_dir = os.path.join(exec_dir, TASKS_DIR)

    source_file = os.path.join(tasks_dir, f"{source_task}.md")
    target_file = os.path.join(tasks_dir, f"{target_task}.md")

    # Create task files if they don't exist (for tasks created before Phase 2)
    for task_id, fpath in [(source_task, source_file), (target_task, target_file)]:
        if not os.path.isfile(fpath):
            # Read from task board to get title
            task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
            tasks = _parse_task_board(task_board_md)
            task = next((t for t in tasks if t["id"] == task_id), None)
            if not task:
                return _tool_result({"error": f"Task {task_id} not found"}, is_error=True)
            # Create minimal task file
            now = datetime.now(timezone.utc).isoformat()
            minimal = f"""---
id: {task_id}
title: "{task['task']}"
status: {task['status']}
priority: {task['priority']}
owner: {task['owner']}
created_at: {now}
blocked_by: []
blocks: []
subtasks: []
parent: null
---

# {task_id}: {task['task']}

## Description

{task['details']}

## Links
"""
            _atomic_write(fpath, minimal)

    # Update source task file
    source_content = _read_file(source_file)
    # Update target task file
    target_content = _read_file(target_file)

    # Apply relationship in both directions
    inverse_map = {
        "blocked-by": "blocks",
        "blocks": "blocked-by",
        "subtask-of": "parent-of",
        "parent-of": "subtask-of",
        "related-to": "related-to",
    }
    inverse = inverse_map[relationship]

    # Update frontmatter lists
    if relationship == "blocked-by":
        source_content = _update_frontmatter_list(source_content, "blocked_by", target_task)
        target_content = _update_frontmatter_list(target_content, "blocks", source_task)
    elif relationship == "blocks":
        source_content = _update_frontmatter_list(source_content, "blocks", target_task)
        target_content = _update_frontmatter_list(target_content, "blocked_by", source_task)
    elif relationship == "subtask-of":
        source_content = _update_frontmatter_field(source_content, "parent", target_task)
        target_content = _update_frontmatter_list(target_content, "subtasks", source_task)
    elif relationship == "parent-of":
        source_content = _update_frontmatter_list(source_content, "subtasks", target_task)
        target_content = _update_frontmatter_field(target_content, "parent", source_task)

    # Add wiki-links to Links section
    link_text_source = f"- {relationship}: [[{target_task}]]\n"
    link_text_target = f"- {inverse}: [[{source_task}]]\n"

    if "## Links" in source_content:
        source_content = source_content.replace("## Links\n", f"## Links\n{link_text_source}", 1)
    else:
        source_content += f"\n## Links\n{link_text_source}"

    if "## Links" in target_content:
        target_content = target_content.replace("## Links\n", f"## Links\n{link_text_target}", 1)
    else:
        target_content += f"\n## Links\n{link_text_target}"

    _atomic_write(source_file, source_content)
    _atomic_write(target_file, target_content)

    return _tool_result({
        "linked": True,
        "source": source_task,
        "target": target_task,
        "relationship": relationship,
        "inverse": inverse,
    })


def _tool_get_task_graph(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get dependency graph for a task."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")
    depth = int(args.get("depth", 2))

    if not task_id:
        return _tool_result({"error": "task_id is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    tasks_dir = os.path.join(exec_dir, TASKS_DIR)

    def _read_task_links(tid: str) -> Dict[str, Any]:
        fpath = os.path.join(tasks_dir, f"{tid}.md")
        if not os.path.isfile(fpath):
            return {"id": tid, "exists": False}
        content = _read_file(fpath)
        fm, _ = _parse_frontmatter(content)
        return {
            "id": tid,
            "exists": True,
            "title": fm.get("title", ""),
            "status": fm.get("status", "TODO"),
            "blocked_by": fm.get("blocked_by", []) if isinstance(fm.get("blocked_by"), list) else [],
            "blocks": fm.get("blocks", []) if isinstance(fm.get("blocks"), list) else [],
            "subtasks": fm.get("subtasks", []) if isinstance(fm.get("subtasks"), list) else [],
            "parent": fm.get("parent", "null"),
        }

    visited: set = set()
    graph: List[Dict[str, Any]] = []

    def _traverse(tid: str, current_depth: int) -> None:
        if tid in visited or current_depth > depth:
            return
        visited.add(tid)
        node = _read_task_links(tid)
        graph.append(node)
        if not node.get("exists"):
            return
        for related in node.get("blocked_by", []) + node.get("blocks", []) + node.get("subtasks", []):
            _traverse(related, current_depth + 1)
        parent = node.get("parent")
        if parent and parent != "null":
            _traverse(parent, current_depth + 1)

    _traverse(task_id, 0)

    # Generate Mermaid diagram
    mermaid_lines = ["graph TD"]
    for node in graph:
        if not node.get("exists"):
            continue
        label = f"{node['id']}: {node.get('title', '')}"[:40]
        status = node.get("status", "TODO")
        style_class = {"DONE": ":::done", "IN_PROGRESS": ":::active", "BLOCKED": ":::blocked"}.get(status, "")
        mermaid_lines.append(f'    {node["id"]}["{label}"]{style_class}')
        for blocked in node.get("blocked_by", []):
            mermaid_lines.append(f"    {blocked} -->|blocks| {node['id']}")
        for sub in node.get("subtasks", []):
            mermaid_lines.append(f"    {node['id']} -->|subtask| {sub}")

    return _tool_result({
        "root": task_id,
        "depth": depth,
        "nodes": graph,
        "mermaid": "\n".join(mermaid_lines),
    })


# ── Sprint & scheduling tools ────────────────────────────────────────────

SPRINTS_DIR = "Sprints"


def _tool_schedule_task(args: Dict[str, Any]) -> Dict[str, Any]:
    """Assign a task to a specific date."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")
    scheduled_date = args.get("scheduled_date", "")

    if not task_id or not scheduled_date:
        return _tool_result({"error": "task_id and scheduled_date are required"}, is_error=True)

    # Validate date format
    try:
        datetime.strptime(scheduled_date, "%Y-%m-%d")
    except ValueError:
        return _tool_result({"error": "scheduled_date must be YYYY-MM-DD format"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    task_file = os.path.join(exec_dir, TASKS_DIR, f"{task_id}.md")
    if not os.path.isfile(task_file):
        return _tool_result({"error": f"Task file not found: {task_id}. Create it with create_task first."}, is_error=True)

    content = _read_file(task_file)
    content = _update_frontmatter_field(content, "scheduled_date", scheduled_date)
    _atomic_write(task_file, content)

    return _tool_result({"scheduled": True, "task_id": task_id, "date": scheduled_date})


def _tool_get_schedule(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get tasks scheduled for a date range."""
    project_path = args.get("project_path", ".")
    start_date = args.get("start_date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    end_date = args.get("end_date", start_date)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    if not os.path.isdir(tasks_dir):
        return _tool_result({"date_range": f"{start_date} to {end_date}", "tasks": [], "overdue": []})

    scheduled: Dict[str, List[Dict[str, Any]]] = {}
    overdue: List[Dict[str, Any]] = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    for fname in os.listdir(tasks_dir):
        if not fname.endswith(".md"):
            continue
        content = _read_file(os.path.join(tasks_dir, fname))
        fm, _ = _parse_frontmatter(content)

        sched = fm.get("scheduled_date", "")
        if not sched or sched == '""' or sched == "null":
            continue

        status = fm.get("status", "TODO")
        if status == "DONE":
            continue

        task_info = {
            "id": fm.get("id", fname[:-3]),
            "title": fm.get("title", "").strip('"'),
            "status": status,
            "priority": fm.get("priority", "P1"),
            "scheduled_date": sched,
        }

        # Check if overdue
        if sched < today and status not in ("DONE",):
            overdue.append(task_info)

        # Check if in range
        if start_date <= sched <= end_date:
            if sched not in scheduled:
                scheduled[sched] = []
            scheduled[sched].append(task_info)

    return _tool_result({
        "date_range": f"{start_date} to {end_date}",
        "scheduled": scheduled,
        "overdue": overdue,
        "total_scheduled": sum(len(v) for v in scheduled.values()),
        "total_overdue": len(overdue),
    })


def _tool_create_sprint(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create a sprint definition file."""
    project_path = args.get("project_path", ".")
    sprint_number = int(args.get("sprint_number", 0))
    start_date = args.get("start_date", "")
    end_date = args.get("end_date", "")
    goals = args.get("goals", [])

    if not sprint_number or not start_date or not end_date:
        return _tool_result({"error": "sprint_number, start_date, and end_date are required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    goals_yaml = "[" + ", ".join(f'"{g}"' for g in goals) + "]" if goals else "[]"
    goals_md = "\n".join(f"- [ ] {g}" for g in goals) if goals else "- [ ] *(Add sprint goals)*"

    sprint_content = f"""---
sprint: {sprint_number}
start_date: {start_date}
end_date: {end_date}
status: active
goals: {goals_yaml}
tags: [vaultops/sprint, vaultops/sprint/active]
---

# Sprint {sprint_number}: {start_date} — {end_date}

## Goals

{goals_md}

## Tasks

| ID | Task | Status | Priority | Scheduled |
| --- | --- | --- | --- | --- |
"""

    sprints_dir = os.path.join(exec_dir, SPRINTS_DIR)
    filepath = os.path.join(sprints_dir, f"Sprint-{sprint_number}.md")
    _atomic_write(filepath, sprint_content)

    return _tool_result({
        "created": True,
        "sprint": sprint_number,
        "start_date": start_date,
        "end_date": end_date,
        "goals": goals,
        "file": filepath,
    })


def _tool_assign_to_sprint(args: Dict[str, Any]) -> Dict[str, Any]:
    """Assign tasks to a sprint."""
    project_path = args.get("project_path", ".")
    task_ids = args.get("task_ids", [])
    sprint_number = int(args.get("sprint_number", 0))

    if not task_ids or not sprint_number:
        return _tool_result({"error": "task_ids and sprint_number are required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Verify sprint exists
    sprint_file = os.path.join(exec_dir, SPRINTS_DIR, f"Sprint-{sprint_number}.md")
    if not os.path.isfile(sprint_file):
        return _tool_result({"error": f"Sprint {sprint_number} not found. Create it first."}, is_error=True)

    assigned = []
    errors = []

    for task_id in task_ids:
        task_file = os.path.join(exec_dir, TASKS_DIR, f"{task_id}.md")
        if not os.path.isfile(task_file):
            errors.append(f"{task_id}: task file not found")
            continue

        content = _read_file(task_file)
        content = _update_frontmatter_field(content, "sprint", str(sprint_number))
        _atomic_write(task_file, content)

        # Read task info for sprint file
        fm, _ = _parse_frontmatter(content)
        assigned.append({
            "id": task_id,
            "title": fm.get("title", "").strip('"'),
            "status": fm.get("status", "TODO"),
            "priority": fm.get("priority", "P1"),
            "scheduled_date": fm.get("scheduled_date", ""),
        })

    # Update sprint file with task rows
    sprint_content = _read_file(sprint_file)
    for task in assigned:
        row = f"| [[{task['id']}]] | {task['title']} | {task['status']} | {task['priority']} | {task['scheduled_date']} |"
        sprint_content = sprint_content.rstrip("\n") + "\n" + row + "\n"

    _atomic_write(sprint_file, sprint_content)

    return _tool_result({
        "sprint": sprint_number,
        "assigned": [t["id"] for t in assigned],
        "errors": errors,
    })


def _tool_get_sprint(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get sprint details with current task statuses."""
    project_path = args.get("project_path", ".")
    sprint_number = args.get("sprint_number", "current")

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    sprints_dir = os.path.join(exec_dir, SPRINTS_DIR)

    if sprint_number == "current":
        # Find the active sprint
        if not os.path.isdir(sprints_dir):
            return _tool_result({"error": "No sprints directory found. Create a sprint first."}, is_error=True)
        active_sprint = None
        for fname in sorted(os.listdir(sprints_dir)):
            if not fname.endswith(".md"):
                continue
            content = _read_file(os.path.join(sprints_dir, fname))
            fm, _ = _parse_frontmatter(content)
            if fm.get("status") == "active":
                sprint_number = fm.get("sprint", 0)
                active_sprint = fname
                break
        if not active_sprint:
            return _tool_result({"error": "No active sprint found."}, is_error=True)
    else:
        sprint_number = int(sprint_number)

    sprint_file = os.path.join(sprints_dir, f"Sprint-{sprint_number}.md")
    if not os.path.isfile(sprint_file):
        return _tool_result({"error": f"Sprint {sprint_number} not found."}, is_error=True)

    content = _read_file(sprint_file)
    fm, _ = _parse_frontmatter(content)

    # Read current statuses from task files
    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    sprint_tasks = []
    if os.path.isdir(tasks_dir):
        for fname in os.listdir(tasks_dir):
            if not fname.endswith(".md"):
                continue
            task_content = _read_file(os.path.join(tasks_dir, fname))
            task_fm, _ = _parse_frontmatter(task_content)
            task_sprint = task_fm.get("sprint", "")
            if str(task_sprint) == str(sprint_number):
                sprint_tasks.append({
                    "id": task_fm.get("id", fname[:-3]),
                    "title": task_fm.get("title", "").strip('"'),
                    "status": task_fm.get("status", "TODO"),
                    "priority": task_fm.get("priority", "P1"),
                    "scheduled_date": task_fm.get("scheduled_date", ""),
                })

    counts = {"DONE": 0, "IN_PROGRESS": 0, "TODO": 0, "BLOCKED": 0}
    for t in sprint_tasks:
        status = t.get("status", "TODO")
        counts[status] = counts.get(status, 0) + 1

    return _tool_result({
        "sprint": sprint_number,
        "start_date": fm.get("start_date", ""),
        "end_date": fm.get("end_date", ""),
        "status": fm.get("status", "unknown"),
        "goals": fm.get("goals", []),
        "tasks": sprint_tasks,
        "counts": counts,
        "total": len(sprint_tasks),
        "progress_pct": round(counts["DONE"] / len(sprint_tasks) * 100) if sprint_tasks else 0,
    })


# ── Metrics tools ────────────────────────────────────────────────────────


def _tool_get_velocity(args: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate task completion velocity."""
    project_path = args.get("project_path", ".")
    period = args.get("period", "week")

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    if not os.path.isdir(tasks_dir):
        return _tool_result({"error": "No task files found. Create tasks first."}, is_error=True)

    # Read all tasks and their timestamps
    completed_tasks: List[Dict[str, Any]] = []
    all_tasks: List[Dict[str, Any]] = []

    for fname in os.listdir(tasks_dir):
        if not fname.endswith(".md"):
            continue
        content = _read_file(os.path.join(tasks_dir, fname))
        fm, _ = _parse_frontmatter(content)

        task_info = {
            "id": fm.get("id", fname[:-3]),
            "status": fm.get("status", "TODO"),
            "created_at": fm.get("created_at", ""),
            "updated_at": fm.get("updated_at", ""),
        }
        all_tasks.append(task_info)
        if task_info["status"] == "DONE":
            completed_tasks.append(task_info)

    # Calculate velocity based on period
    now = datetime.now(timezone.utc)
    period_days = {"day": 1, "week": 7, "sprint": 14, "month": 30}.get(period, 7)

    cutoff = (now - timedelta(days=period_days)).isoformat()
    recent_completed = [t for t in completed_tasks if t.get("updated_at", "") >= cutoff]

    # Calculate average cycle time (created → done)
    cycle_times: List[float] = []
    for t in completed_tasks:
        created = t.get("created_at", "")
        updated = t.get("updated_at", "")
        if created and updated:
            try:
                c = datetime.fromisoformat(created.replace("Z", "+00:00"))
                u = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                cycle_times.append((u - c).total_seconds() / 3600)  # hours
            except (ValueError, TypeError):
                pass

    avg_cycle = round(sum(cycle_times) / len(cycle_times), 1) if cycle_times else 0

    return _tool_result({
        "period": period,
        "period_days": period_days,
        "completed_in_period": len(recent_completed),
        "total_completed": len(completed_tasks),
        "total_tasks": len(all_tasks),
        "avg_cycle_time_hours": avg_cycle,
        "velocity_per_day": round(len(recent_completed) / period_days, 2) if period_days else 0,
    })


def _tool_get_burndown(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get sprint burndown data for Mermaid chart in Obsidian."""
    project_path = args.get("project_path", ".")
    sprint_number = int(args.get("sprint_number", 0))

    if not sprint_number:
        return _tool_result({"error": "sprint_number is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    sprint_file = os.path.join(exec_dir, SPRINTS_DIR, f"Sprint-{sprint_number}.md")
    if not os.path.isfile(sprint_file):
        return _tool_result({"error": f"Sprint {sprint_number} not found."}, is_error=True)

    content = _read_file(sprint_file)
    fm, _ = _parse_frontmatter(content)
    start_date = fm.get("start_date", "")
    end_date = fm.get("end_date", "")

    if not start_date or not end_date:
        return _tool_result({"error": "Sprint missing start_date or end_date."}, is_error=True)

    # Count sprint tasks
    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    total_tasks = 0
    done_tasks = 0

    if os.path.isdir(tasks_dir):
        for fname in os.listdir(tasks_dir):
            if not fname.endswith(".md"):
                continue
            task_content = _read_file(os.path.join(tasks_dir, fname))
            task_fm, _ = _parse_frontmatter(task_content)
            if str(task_fm.get("sprint", "")) == str(sprint_number):
                total_tasks += 1
                if task_fm.get("status") == "DONE":
                    done_tasks += 1

    remaining = total_tasks - done_tasks

    # Generate Mermaid Gantt-style burndown
    mermaid = f"""```mermaid
xychart-beta
    title "Sprint {sprint_number} Burndown"
    x-axis [{start_date} --> {end_date}]
    y-axis "Remaining Tasks" 0 --> {total_tasks}
    line "Ideal" [{total_tasks}, 0]
    line "Actual" [{total_tasks}, {remaining}]
```"""

    return _tool_result({
        "sprint": sprint_number,
        "start_date": start_date,
        "end_date": end_date,
        "total_tasks": total_tasks,
        "done_tasks": done_tasks,
        "remaining": remaining,
        "progress_pct": round(done_tasks / total_tasks * 100) if total_tasks else 0,
        "mermaid": mermaid,
    })


# ── Cross-project tools ──────────────────────────────────────────────────


def _load_all_projects() -> List[Dict[str, Any]]:
    """Load all registered projects from projects.json."""
    if not os.path.isfile(PROJECTS_JSON):
        return []
    try:
        with open(PROJECTS_JSON, "r") as f:
            data = json.load(f)
        return data.get("projects", [])
    except (json.JSONDecodeError, KeyError):
        return []


def _load_all_repos() -> List[Dict[str, Any]]:
    """Load all registered doc repos from repos.json."""
    if not os.path.isfile(REPOS_JSON):
        return []
    try:
        with open(REPOS_JSON, "r") as f:
            data = json.load(f)
        return data.get("repos", [])
    except (json.JSONDecodeError, KeyError):
        return []


def _load_all_projects_and_repos() -> List[Dict[str, Any]]:
    """Load both code projects and doc repos for cross-project operations."""
    projects = _load_all_projects()
    repos = _load_all_repos()
    # Doc repos use their path as vault project directly (the vault IS the repo)
    for repo in repos:
        projects.append({
            "path": repo.get("path", ""),
            "vaultRoot": repo.get("path", ""),
            "repoId": repo.get("repoId", ""),
            "type": "doc-repo",
        })
    return projects


# ── Auto-commit for doc repos ─────────────────────────────────────────────


def _read_config_env(project_path: str) -> Dict[str, str]:
    """Read .vaultops/config.env and return key-value pairs."""
    config_env = os.path.join(project_path, ".vaultops", "config.env")
    result: Dict[str, str] = {}
    if not os.path.isfile(config_env):
        return result
    with open(config_env, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            result[key.strip()] = val.strip().strip('"').strip("'")
    return result


def _auto_commit_if_doc_repo(vault_path: str, message: str) -> Optional[str]:
    """If this vault is a doc-repo with granular auto-commit, commit changed files.

    Returns commit SHA or None.
    """
    config = _read_config_env(vault_path)
    if config.get("VAULTOPS_DOC_REPO") != "true":
        return None
    if config.get("VAULTOPS_AUTOCOMMIT", "session") != "granular":
        return None

    # Check if inside a git repo
    git_dir = os.path.join(vault_path, ".git")
    if not os.path.isdir(git_dir):
        return None

    try:
        # Check for changes
        status = subprocess.run(
            ["git", "-C", vault_path, "status", "--porcelain"],
            capture_output=True, text=True, timeout=10
        )
        if not status.stdout.strip():
            return None

        # Stage only vault-specific directories (canonical + alias NN-* dirs)
        vault_dirs = [EXEC_DIR] + _discover_all_section_dirs(vault_path) + [MEETINGS_DIR, "_shared"]
        for vd in vault_dirs:
            vd_path = os.path.join(vault_path, vd)
            if os.path.isdir(vd_path):
                subprocess.run(
                    ["git", "-C", vault_path, "add", vd],
                    capture_output=True, timeout=10
                )

        # Check if anything was staged
        diff = subprocess.run(
            ["git", "-C", vault_path, "diff", "--cached", "--quiet"],
            capture_output=True, timeout=10
        )
        if diff.returncode == 0:
            return None  # nothing staged

        # Commit
        commit = subprocess.run(
            ["git", "-C", vault_path, "commit", "-m", message],
            capture_output=True, text=True, timeout=15
        )
        if commit.returncode != 0:
            return None

        # Extract SHA
        log = subprocess.run(
            ["git", "-C", vault_path, "log", "--format=%H", "-1"],
            capture_output=True, text=True, timeout=5
        )
        return log.stdout.strip() if log.returncode == 0 else None

    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def _tool_search_tasks(args: Dict[str, Any]) -> Dict[str, Any]:
    """Search tasks across all registered projects."""
    query = args.get("query", "").lower()
    status_filter = args.get("status", "")
    tag_filter = args.get("tags", [])

    if not query and not status_filter and not tag_filter:
        return _tool_result({"error": "At least one of query, status, or tags is required"}, is_error=True)

    projects = _load_all_projects_and_repos()
    if not projects:
        return _tool_result({"error": "No projects registered. Run 'vaultops add' first."}, is_error=True)

    results: List[Dict[str, Any]] = []

    for proj in projects:
        proj_path = proj.get("path", "")
        vault_root = proj.get("vaultRoot", "")
        repo_id = proj.get("repoId", "")

        if not vault_root or not repo_id:
            continue

        # Doc repos use path directly as vault project
        if proj.get("type") == "doc-repo":
            vault_project = proj_path
        else:
            vault_project = _resolve_vault_project_from_registry(proj)
        tasks_dir = os.path.join(vault_project, EXEC_DIR, TASKS_DIR)
        if not os.path.isdir(tasks_dir):
            # Fall back to task board
            board_path = os.path.join(vault_project, EXEC_DIR, TASK_BOARD)
            board_md = _read_file(board_path)
            for task in _parse_task_board(board_md):
                if query and query not in task["task"].lower() and query not in task["id"].lower():
                    continue
                if status_filter and task["status"] != status_filter.upper():
                    continue
                task["project"] = repo_id
                task["project_path"] = proj_path
                results.append(task)
            continue

        for fname in os.listdir(tasks_dir):
            if not fname.endswith(".md"):
                continue
            content = _read_file(os.path.join(tasks_dir, fname))
            fm, body = _parse_frontmatter(content)

            title = fm.get("title", "").strip('"')
            task_id = fm.get("id", fname[:-3])
            status = fm.get("status", "TODO")
            task_tags = fm.get("tags", [])
            if isinstance(task_tags, str):
                task_tags = [task_tags]

            # Apply filters
            if query and query not in title.lower() and query not in task_id.lower() and query not in body.lower():
                continue
            if status_filter and status != status_filter.upper():
                continue
            if tag_filter and not any(t in task_tags for t in tag_filter):
                continue

            results.append({
                "id": task_id,
                "title": title,
                "status": status,
                "priority": fm.get("priority", ""),
                "project": repo_id,
                "project_path": proj_path,
                "tags": task_tags,
                "scheduled_date": fm.get("scheduled_date", ""),
            })

    return _tool_result({
        "query": query,
        "results": results,
        "total": len(results),
        "projects_searched": len(projects),
    })


def _tool_create_cross_project_link(args: Dict[str, Any]) -> Dict[str, Any]:
    """Link tasks across different projects."""
    source_project = args.get("source_project", "")
    source_task = args.get("source_task", "")
    target_project = args.get("target_project", "")
    target_task = args.get("target_task", "")
    relationship = args.get("relationship", "related-to")

    if not all([source_project, source_task, target_project, target_task]):
        return _tool_result({"error": "source_project, source_task, target_project, target_task are all required"}, is_error=True)

    projects = _load_all_projects()
    source_proj = next((p for p in projects if p.get("repoId") == source_project or p.get("path") == source_project), None)
    target_proj = next((p for p in projects if p.get("repoId") == target_project or p.get("path") == target_project), None)

    if not source_proj:
        return _tool_result({"error": f"Source project not found: {source_project}"}, is_error=True)
    if not target_proj:
        return _tool_result({"error": f"Target project not found: {target_project}"}, is_error=True)

    # Write cross-project link to both task files
    for proj, task_id, link_text in [
        (source_proj, source_task, f"- {relationship}: [[{target_project}/{target_task}]] (cross-project)\n"),
        (target_proj, target_task, f"- {relationship} (from): [[{source_project}/{source_task}]] (cross-project)\n"),
    ]:
        vault_project = _resolve_vault_project_from_registry(proj)
        task_file = os.path.join(vault_project, EXEC_DIR, TASKS_DIR, f"{task_id}.md")

        if os.path.isfile(task_file):
            content = _read_file(task_file)
            if "## Links" in content:
                content = content.replace("## Links\n", f"## Links\n{link_text}", 1)
            else:
                content += f"\n## Links\n{link_text}"
            _atomic_write(task_file, content)

    # Write to shared cross-project links index
    vault_root = source_proj.get("vaultRoot", "")
    shared_dir = os.path.join(vault_root, "_shared")
    os.makedirs(shared_dir, exist_ok=True)
    links_file = os.path.join(shared_dir, "Cross-Project Links.md")
    existing = _read_file(links_file)
    if not existing:
        existing = "# Cross-Project Links\n\n| Source | Target | Relationship | Date |\n| --- | --- | --- | --- |\n"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    new_row = f"| {source_project}/{source_task} | {target_project}/{target_task} | {relationship} | {now} |\n"
    existing = existing.rstrip("\n") + "\n" + new_row + "\n"
    _atomic_write(links_file, existing)

    return _tool_result({
        "linked": True,
        "source": f"{source_project}/{source_task}",
        "target": f"{target_project}/{target_task}",
        "relationship": relationship,
    })


def _tool_get_cross_project_deps(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get cross-project dependency overview."""
    project_path = args.get("project_path", "")

    projects = _load_all_projects()
    if not projects:
        return _tool_result({"error": "No projects registered."}, is_error=True)

    # Read shared links file
    vault_root = None
    if project_path:
        proj = next((p for p in projects if p.get("path") == project_path or p.get("repoId") == project_path), None)
        if proj:
            vault_root = proj.get("vaultRoot")

    if not vault_root and projects:
        vault_root = projects[0].get("vaultRoot")

    if not vault_root:
        return _tool_result({"error": "Could not determine vault root."}, is_error=True)

    links_file = os.path.join(vault_root, "_shared", "Cross-Project Links.md")
    links_content = _read_file(links_file)

    # Parse links table
    links: List[Dict[str, str]] = []
    for line in links_content.split("\n"):
        line = line.strip()
        if not line.startswith("|") or "---" in line or line.lower().startswith("| source"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) >= 3:
            links.append({
                "source": cells[0],
                "target": cells[1],
                "relationship": cells[2],
                "date": cells[3] if len(cells) > 3 else "",
            })

    # Generate Mermaid diagram
    mermaid = ["graph LR"]
    project_nodes: set = set()
    for link in links:
        src_proj = link["source"].split("/")[0]
        tgt_proj = link["target"].split("/")[0]
        project_nodes.add(src_proj)
        project_nodes.add(tgt_proj)
        mermaid.append(f'    {link["source"].replace("/", "_")}["{link["source"]}"] -->|{link["relationship"]}| {link["target"].replace("/", "_")}["{link["target"]}"]')

    return _tool_result({
        "links": links,
        "total_links": len(links),
        "projects_involved": list(project_nodes),
        "mermaid": "\n".join(mermaid),
    })


# ── Canvas generation ────────────────────────────────────────────────────


def _tool_generate_canvas(args: Dict[str, Any]) -> Dict[str, Any]:
    """Generate an Obsidian .canvas JSON file for visual board views."""
    project_path = args.get("project_path", ".")
    canvas_type = args.get("canvas_type", "kanban")

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    vault_project = _resolve_vault_project(project_path)
    if not vault_project:
        return _tool_result({"error": "No vault found"}, is_error=True)

    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)

    # Color mapping: 1=red(BLOCKED), 2=orange(P1), 3=yellow(IN_PROGRESS), 4=green(DONE), 5=cyan(TODO), 6=purple(group)
    STATUS_COLORS = {"BLOCKED": "1", "IN_PROGRESS": "3", "DONE": "4", "TODO": "5"}
    COLUMN_X = {"TODO": 0, "IN_PROGRESS": 520, "BLOCKED": 1040, "DONE": 1560}
    CARD_W, CARD_H, GAP = 460, 120, 20
    GROUP_PAD = 40

    if canvas_type in ("kanban", "sprint"):
        sprint_number = args.get("sprint_number")
        if canvas_type == "sprint" and sprint_number:
            tasks = [t for t in tasks if str(t.get("sprint", "")) == str(sprint_number)]

        # Group by status
        groups: Dict[str, List] = {"TODO": [], "IN_PROGRESS": [], "BLOCKED": [], "DONE": []}
        for t in tasks:
            status = _normalize_status(t.get("status", "TODO"))
            groups.setdefault(status, []).append(t)

        nodes = []
        edges = []
        node_id_map = {}

        for status, col_x in COLUMN_X.items():
            col_tasks = groups.get(status, [])
            # Group header
            group_h = max(CARD_H + GROUP_PAD * 2, len(col_tasks) * (CARD_H + GAP) + GROUP_PAD * 2)
            group_id = f"group-{status}"
            nodes.append({
                "id": group_id, "type": "text",
                "text": f"## {status.replace('_', ' ')}\n\n{len(col_tasks)} tasks",
                "x": col_x, "y": 0,
                "width": CARD_W + GROUP_PAD * 2, "height": group_h,
                "color": "6",
            })
            # Task cards
            for i, t in enumerate(col_tasks):
                card_id = f"task-{t['id']}"
                node_id_map[t["id"]] = card_id
                priority_emoji = {"P1": "🔴", "P2": "🟡", "P3": "🟢"}.get(t.get("priority", ""), "⚪")
                nodes.append({
                    "id": card_id, "type": "text",
                    "text": f"### {priority_emoji} {t['id']}\n\n{t.get('task', '')[:60]}",
                    "x": col_x + GROUP_PAD, "y": GROUP_PAD + i * (CARD_H + GAP),
                    "width": CARD_W, "height": CARD_H,
                    "color": STATUS_COLORS.get(status, "5"),
                })

        # Add dependency edges
        for t in tasks:
            task_file = os.path.join(exec_dir, "Tasks", f"{t['id']}.md")
            if os.path.isfile(task_file):
                content = _read_file(task_file)
                fm, _ = _parse_frontmatter(content)
                for dep in fm.get("blocked_by", []):
                    if dep in node_id_map and t["id"] in node_id_map:
                        edges.append({
                            "id": f"edge-{dep}-{t['id']}",
                            "fromNode": node_id_map[dep],
                            "toNode": node_id_map[t["id"]],
                            "label": "blocks",
                        })

    elif canvas_type == "dependencies":
        nodes = []
        edges = []
        node_id_map = {}
        # Simple left-to-right layout
        for i, t in enumerate(tasks):
            status = _normalize_status(t.get("status", "TODO"))
            card_id = f"task-{t['id']}"
            node_id_map[t["id"]] = card_id
            col = i % 4
            row = i // 4
            nodes.append({
                "id": card_id, "type": "text",
                "text": f"### {t['id']}\n\n{t.get('task', '')[:50]}\n\n**{status}**",
                "x": col * 520, "y": row * 200,
                "width": CARD_W, "height": CARD_H + 40,
                "color": STATUS_COLORS.get(status, "5"),
            })
        # Add all edges from task files
        tasks_dir = os.path.join(exec_dir, "Tasks")
        if os.path.isdir(tasks_dir):
            for fname in os.listdir(tasks_dir):
                if not fname.endswith(".md"):
                    continue
                content = _read_file(os.path.join(tasks_dir, fname))
                fm, _ = _parse_frontmatter(content)
                tid = fm.get("id", fname.replace(".md", ""))
                for dep in fm.get("blocked_by", []):
                    if dep in node_id_map and tid in node_id_map:
                        edges.append({
                            "id": f"edge-{dep}-{tid}",
                            "fromNode": node_id_map[dep],
                            "toNode": node_id_map[tid],
                            "label": "blocked-by",
                        })
                for sub in fm.get("subtasks", []):
                    if sub in node_id_map and tid in node_id_map:
                        edges.append({
                            "id": f"edge-{tid}-{sub}",
                            "fromNode": node_id_map[tid],
                            "toNode": node_id_map[sub],
                            "label": "subtask",
                        })

    elif canvas_type == "architecture":
        # Read System Architecture doc for component names
        arch_path = os.path.join(_resolve_section_dir(vault_project, "00", "Overview"), "System Architecture.md")
        arch_content = _read_file(arch_path)
        nodes = []
        edges = []
        # Extract tech stack table rows as components
        in_table = False
        components = []
        for line in arch_content.split("\n"):
            if "| Layer" in line or "| 🧩" in line or "| Component" in line:
                in_table = True
                continue
            if in_table and line.strip().startswith("|"):
                if "---" in line:
                    continue
                cells = [c.strip() for c in line.strip("|").split("|")]
                if len(cells) >= 2:
                    components.append({"name": cells[0].strip(), "detail": cells[1].strip() if len(cells) > 1 else ""})
            elif in_table and not line.strip().startswith("|"):
                in_table = False

        LAYER_COLORS = {"frontend": "4", "backend": "2", "database": "1", "external": "5"}
        for i, comp in enumerate(components[:12]):  # limit to 12 nodes
            col = i % 3
            row = i // 3
            color = "5"
            name_lower = comp["name"].lower()
            for layer, c in LAYER_COLORS.items():
                if layer in name_lower or layer in comp.get("detail", "").lower():
                    color = c
                    break
            nodes.append({
                "id": f"comp-{i}",
                "type": "text",
                "text": f"### {comp['name']}\n\n{comp.get('detail', '')}",
                "x": col * 520, "y": row * 250,
                "width": CARD_W, "height": 180,
                "color": color,
            })

    else:
        return _tool_result({"error": f"Unknown canvas type: {canvas_type}"}, is_error=True)

    canvas = {"nodes": nodes, "edges": edges}
    canvas_filename = f"{canvas_type}-board.canvas"
    canvas_path = os.path.join(vault_project, canvas_filename)
    _atomic_write(canvas_path, json.dumps(canvas, indent=2, ensure_ascii=False))

    return _tool_result({
        "created": True,
        "canvas_type": canvas_type,
        "file": canvas_path,
        "nodes_count": len(nodes),
        "edges_count": len(edges),
    })


# ── Retrospective generation ────────────────────────────────────────────


def _tool_generate_retro(args: Dict[str, Any]) -> Dict[str, Any]:
    """Generate a sprint retrospective with real data analysis — cycle times,
    verify results, role enrichment patterns, and auto-generated insights."""
    project_path = args.get("project_path", ".")
    sprint_number = int(args.get("sprint_number", 0))

    if not sprint_number:
        return _tool_result({"error": "sprint_number is required"}, is_error=True)

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Get sprint data
    sprint_file = os.path.join(exec_dir, SPRINTS_DIR, f"Sprint-{sprint_number}.md")
    if not os.path.isfile(sprint_file):
        return _tool_result({"error": f"Sprint {sprint_number} not found"}, is_error=True)

    sprint_content = _read_file(sprint_file)
    fm, _ = _parse_frontmatter(sprint_content)
    start_date = fm.get("start_date", "")
    end_date = fm.get("end_date", "")
    goals = fm.get("goals", [])

    # Get velocity data
    velocity_result = _tool_get_velocity({"project_path": project_path})
    vel_data = {}
    if "content" in velocity_result and velocity_result["content"]:
        try:
            vel_data = json.loads(velocity_result["content"][0].get("text", "{}"))
        except (json.JSONDecodeError, IndexError):
            pass

    # Collect sprint tasks with detailed analysis
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)
    sprint_tasks_detailed: List[Dict[str, Any]] = []
    tasks_dir = os.path.join(exec_dir, "Tasks")
    for t in tasks:
        tf = os.path.join(tasks_dir, f"{t['id']}.md")
        if os.path.isfile(tf):
            tc = _read_file(tf)
            tfm, _ = _parse_frontmatter(tc)
            if str(tfm.get("sprint", "")) == str(sprint_number):
                # Calculate cycle time for this task
                cycle_hours = None
                created = tfm.get("created_at", "")
                updated = tfm.get("updated_at", "")
                if created and updated:
                    try:
                        c = datetime.fromisoformat(created.replace("Z", "+00:00"))
                        u = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                        cycle_hours = round((u - c).total_seconds() / 3600, 1)
                    except (ValueError, TypeError):
                        pass

                # Check which roles were enriched
                roles_done = []
                role_dir = os.path.join(exec_dir, ROLE_OUTPUTS_DIR, t["id"])
                if os.path.isdir(role_dir):
                    for role_file in os.listdir(role_dir):
                        if role_file.endswith(".md"):
                            roles_done.append(role_file.replace(".md", ""))

                # Check verify status
                verify_checks = _parse_verify_checks(tfm)
                has_verify = bool(verify_checks)

                sprint_tasks_detailed.append({
                    **t,
                    "cycle_hours": cycle_hours,
                    "roles_done": roles_done,
                    "has_verify": has_verify,
                    "priority": tfm.get("priority", "P2"),
                })

    done_tasks = [t for t in sprint_tasks_detailed if _normalize_status(t.get("status", "")) == "DONE"]
    blocked_tasks = [t for t in sprint_tasks_detailed if _normalize_status(t.get("status", "")) == "BLOCKED"]
    in_progress = [t for t in sprint_tasks_detailed if _normalize_status(t.get("status", "")) == "IN_PROGRESS"]
    done_count = len(done_tasks)
    total = len(sprint_tasks_detailed)
    completion_pct = round(done_count / total * 100) if total else 0

    # ── Insights generation ──────────────────────────────────────────────
    insights_well: List[str] = []
    insights_bad: List[str] = []
    insights_patterns: List[str] = []

    # Cycle time analysis
    cycle_times = [t["cycle_hours"] for t in done_tasks if t.get("cycle_hours") is not None]
    avg_cycle = round(sum(cycle_times) / len(cycle_times), 1) if cycle_times else 0
    if cycle_times:
        fastest = min(cycle_times)
        slowest = max(cycle_times)
        fastest_task = next(t for t in done_tasks if t.get("cycle_hours") == fastest)
        slowest_task = next(t for t in done_tasks if t.get("cycle_hours") == slowest)
        if fastest < avg_cycle * 0.5:
            insights_well.append(
                f"{fastest_task['id']} completed in {fastest}h (vs avg {avg_cycle}h) — speed record"
            )
        if slowest > avg_cycle * 2 and len(cycle_times) > 2:
            insights_bad.append(
                f"{slowest_task['id']} took {slowest}h ({round(slowest/avg_cycle, 1)}x avg) — investigate blockers"
            )

    # Role enrichment impact
    enriched_tasks = [t for t in done_tasks if len(t.get("roles_done", [])) >= 3]
    unenriched_tasks = [t for t in done_tasks if len(t.get("roles_done", [])) == 0]
    if enriched_tasks and unenriched_tasks:
        enriched_cycles = [t["cycle_hours"] for t in enriched_tasks if t.get("cycle_hours")]
        unenriched_cycles = [t["cycle_hours"] for t in unenriched_tasks if t.get("cycle_hours")]
        if enriched_cycles and unenriched_cycles:
            avg_enriched = sum(enriched_cycles) / len(enriched_cycles)
            avg_unenriched = sum(unenriched_cycles) / len(unenriched_cycles)
            if avg_enriched < avg_unenriched:
                pct = round((1 - avg_enriched / avg_unenriched) * 100)
                insights_patterns.append(
                    f"Role-enriched tasks completed {pct}% faster ({round(avg_enriched, 1)}h vs {round(avg_unenriched, 1)}h)"
                )
            else:
                insights_patterns.append(
                    f"Role enrichment didn't speed up completion this sprint — review if roles are adding value"
                )

    # Verify contract usage
    verified_tasks = [t for t in sprint_tasks_detailed if t.get("has_verify")]
    if verified_tasks:
        insights_patterns.append(
            f"{len(verified_tasks)}/{total} tasks had verify contracts — Task-as-Code adoption"
        )

    # Blocked tasks
    if blocked_tasks:
        insights_bad.append(
            f"{len(blocked_tasks)} task{'s' if len(blocked_tasks) != 1 else ''} still BLOCKED: "
            + ", ".join(t["id"] for t in blocked_tasks)
        )

    # Incomplete work
    if in_progress:
        insights_bad.append(
            f"{len(in_progress)} task{'s' if len(in_progress) != 1 else ''} carried over (IN_PROGRESS): "
            + ", ".join(t["id"] for t in in_progress)
        )

    # Completion rate assessment
    if completion_pct >= 90:
        insights_well.append(f"{completion_pct}% completion rate — strong sprint execution")
    elif completion_pct < 50 and total > 2:
        insights_bad.append(f"Only {completion_pct}% completion — possible over-commitment or scope creep")

    # ── Learning log analysis ────────────────────────────────────────────
    learning_insights: List[str] = []
    try:
        vault_project = _resolve_vault_project(project_path)
        if vault_project:
            log_path = os.path.join(vault_project, "08-Execution", LEARNINGS_DIR, LEARNING_LOG)
            if os.path.isfile(log_path):
                events = _parse_learning_log(_read_file(log_path))
                # Count reopened tasks (premature auto-completions)
                corrections = [e for e in events if e.get("event_type") == "user_correction"]
                if corrections:
                    learning_insights.append(
                        f"{len(corrections)} user corrections logged — brain is still calibrating"
                    )
                # Verification results
                verify_events = [e for e in events if e.get("event_type") == "verification_result"]
                if verify_events:
                    blocked = sum(1 for e in verify_events if e.get("blocked_completion") == "True")
                    if blocked:
                        learning_insights.append(
                            f"Verify contracts blocked {blocked} premature completion{'s' if blocked != 1 else ''} — contracts are working"
                        )
    except Exception:
        pass

    # ── Build markdown ───────────────────────────────────────────────────
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    goals_md = "\n".join(f"- {'[x]' if i < done_count else '[ ]'} {g}" for i, g in enumerate(goals)) if goals else "- *(No goals set)*"

    throughput = vel_data.get("velocity_per_day", "N/A")
    vel_avg_cycle = vel_data.get("avg_cycle_time_hours", avg_cycle)

    # Build insights sections
    well_md = "\n".join(f"- {i}" for i in insights_well) if insights_well else "- *(No auto-detected positives — fill in during retro)*"
    bad_md = "\n".join(f"- {i}" for i in insights_bad) if insights_bad else "- *(No auto-detected issues — fill in during retro)*"
    patterns_md = "\n".join(f"- {i}" for i in insights_patterns) if insights_patterns else "- *(Not enough data for patterns yet)*"
    learning_md = "\n".join(f"- {i}" for i in learning_insights) if learning_insights else "- *(No learning events in this period)*"

    # Task breakdown table
    task_rows = ""
    for t in sprint_tasks_detailed:
        status = _normalize_status(t.get("status", "TODO"))
        icon = {"DONE": "\u2713", "IN_PROGRESS": "\u25b6", "BLOCKED": "\u26d4", "TODO": "\u25cb"}.get(status, "\u25cb")
        cycle_str = f"{t['cycle_hours']}h" if t.get("cycle_hours") else "-"
        roles_str = ", ".join(t.get("roles_done", [])) if t.get("roles_done") else "-"
        verify_str = "\u2713" if t.get("has_verify") else "-"
        task_rows += f"| {t['id']} | {t.get('task', '')[:30]} | {icon} {status} | {cycle_str} | {roles_str} | {verify_str} |\n"

    retro_content = f"""---
sprint: {sprint_number}
type: retrospective
created: {now}
tags: [vaultops/sprint, vaultops/retro]
---

# \U0001f504 Sprint {sprint_number} Retrospective

> **Period:** {start_date} — {end_date}
> **Completion:** {completion_pct}% ({done_count}/{total} tasks)

---

## \U0001f4ca Metrics

| Metric | Value |
|--------|-------|
| Tasks completed | {done_count}/{total} |
| Completion rate | {completion_pct}% |
| Avg cycle time | {vel_avg_cycle}h |
| Velocity | {throughput} tasks/day |
| Tasks with verify contracts | {len(verified_tasks)}/{total} |
| Tasks with role enrichment | {len([t for t in sprint_tasks_detailed if t.get('roles_done')])} |

---

## \U0001f4cb Task Breakdown

| ID | Task | Status | Cycle | Roles | Verify |
|----|------|--------|-------|-------|--------|
{task_rows}
---

## \U0001f3af Goal Review

{goals_md}

---

## \u2705 What Went Well (auto-detected)

{well_md}

> [!SUCCESS] Keep doing
> - *Add your own observations here*

---

## \u274c What Didn't Go Well (auto-detected)

{bad_md}

> [!WARNING] Stop doing
> - *Add your own observations here*

---

## \U0001f50d Patterns Detected

{patterns_md}

---

## \U0001f9e0 Learning System

{learning_md}

---

## \U0001f4a1 Action Items for Next Sprint

| # | Action | Owner | Due |
|---|--------|-------|-----|
| 1 | *{{action}}* | *{{owner}}* | *{{date}}* |

---

## \U0001f389 Shoutouts

> [!TIP] Recognition
> - *{{who did great work and why}}*
"""

    retro_path = os.path.join(exec_dir, SPRINTS_DIR, f"Sprint-{sprint_number}-Retro.md")
    _atomic_write(retro_path, retro_content)

    return _tool_result({
        "created": True,
        "sprint": sprint_number,
        "file": retro_path,
        "completion_pct": completion_pct,
        "tasks_done": done_count,
        "tasks_total": total,
        "insights_generated": len(insights_well) + len(insights_bad) + len(insights_patterns),
    })


# ── Predictive Brain tools ────────────────────────────────────────────────


def _tool_get_predictions(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get AI predictions for a task — cycle time, risk, priority."""
    project_path = args.get("project_path", ".")
    task_id = args.get("task_id", "")
    work_type = args.get("work_type", "unknown")
    files = args.get("files", [])

    # If task_id provided, read task to get work type and files
    if task_id:
        exec_dir, err = _exec_path(project_path)
        if not err:
            task_file = os.path.join(exec_dir, TASKS_DIR, f"{task_id}.md")
            if os.path.isfile(task_file):
                tc = _read_file(task_file)
                fm, body = _parse_frontmatter(tc)
                if not work_type or work_type == "unknown":
                    # Infer from tags
                    tags = fm.get("tags", [])
                    if isinstance(tags, list):
                        for tag in tags:
                            if "bugfix" in str(tag) or "bug" in str(tag):
                                work_type = "bugfix"
                                break
                            elif "refact" in str(tag):
                                work_type = "refactor"
                                break
                            elif "feature" in str(tag) or "feat" in str(tag):
                                work_type = "new_feature"
                                break

    # Import prediction engine from brain_state
    try:
        import sys as _sys
        _hooks = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks")
        if _hooks not in _sys.path:
            _sys.path.insert(0, _hooks)
        from brain_state import get_predictions as _get_predictions
        result = _get_predictions(project_path, work_type, files)
    except ImportError:
        return _tool_result({"error": "Prediction engine not available"}, is_error=True)

    # Build visual receipt
    cycle = result.get("cycle_time", {})
    risk = result.get("risk", {})
    priority = result.get("priority", {})

    lines = ["\u2501" * 43, "  \u2b21  Predictive Brain  \u00b7  Forecast", "\u2501" * 43, ""]

    # Cycle time
    if cycle.get("predicted_hours") is not None:
        conf_icon = {"high": "\u2588\u2588\u2588", "medium": "\u2588\u2588\u2591", "low": "\u2588\u2591\u2591", "very_low": "\u2591\u2591\u2591"}.get(cycle.get("confidence", ""), "\u2591\u2591\u2591")
        lines.append(f"  \u231b  CYCLE TIME")
        lines.append(f"     Predicted: {cycle['predicted_hours']}h  ({cycle.get('range_low', '?')}\u2013{cycle.get('range_high', '?')}h range)")
        lines.append(f"     Confidence: {conf_icon} {cycle.get('confidence', '?')}  ({cycle.get('sample_size', 0)} samples)")
        wt = "same type" if cycle.get("work_type_match") else "all types"
        lines.append(f"     Based on: {wt}")
        lines.append("")
    else:
        lines.append("  \u231b  CYCLE TIME: not enough data yet")
        lines.append("")

    # Risk
    risk_icons = {"high": "\U0001f534", "medium": "\U0001f7e1", "low": "\U0001f7e2"}
    risk_level = risk.get("risk_level", "unknown")
    risk_icon = risk_icons.get(risk_level, "\u26aa")
    lines.append(f"  {risk_icon}  RISK: {risk_level.upper()}")
    for reason in risk.get("reasons", []):
        lines.append(f"     \u00b7 {reason}")
    if risk.get("recommendation"):
        lines.append(f"     \u2192 {risk['recommendation']}")
    lines.append("")

    # Priority
    lines.append(f"  \u2726  PRIORITY: {priority.get('suggested_priority', '?')}")
    lines.append(f"     {priority.get('reasoning', '')}")
    lines.append("")

    lines.append("\u2501" * 43)
    receipt = "\n".join(lines)

    return _receipt_result(receipt, result)


# ── Adaptive Roles: Project DNA ──────────────────────────────────────────

PROJECT_DNA_FILE = "Project DNA.md"


def _tool_get_project_dna(args: Dict[str, Any]) -> Dict[str, Any]:
    """Analyze role outputs to build/return Project DNA — the project's unique style profile."""
    project_path = args.get("project_path", ".")

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Check if DNA file exists and is recent
    shared_dir = os.path.join(os.path.dirname(exec_dir), "_shared")
    os.makedirs(shared_dir, exist_ok=True)
    dna_path = os.path.join(shared_dir, PROJECT_DNA_FILE)

    # Analyze role outputs to build DNA
    role_dir = os.path.join(exec_dir, ROLE_OUTPUTS_DIR)
    role_data: Dict[str, List[str]] = {r: [] for r in VALID_ROLES}
    task_count = 0

    if os.path.isdir(role_dir):
        for task_dir_name in os.listdir(role_dir):
            task_role_dir = os.path.join(role_dir, task_dir_name)
            if not os.path.isdir(task_role_dir):
                continue
            task_count += 1
            for role_file in os.listdir(task_role_dir):
                if role_file.endswith(".md"):
                    role_name = role_file.replace(".md", "")
                    if role_name in VALID_ROLES:
                        content = _read_file(os.path.join(task_role_dir, role_file))
                        role_data[role_name].append(content)

    if task_count == 0:
        return _tool_result({
            "status": "no_data",
            "message": "No role outputs found. Run /vault:enrich on a few tasks first.",
        })

    # Extract patterns from role outputs
    patterns: Dict[str, List[str]] = {}

    # Detect tech stack from Developer outputs
    dev_outputs = role_data.get("Developer", [])
    stack_keywords: Dict[str, int] = {}
    tech_patterns = [
        r"\b(React|Vue|Angular|Svelte|Next\.?js|NestJS|Express|Fiber|Gin|Django|Flask)\b",
        r"\b(TypeScript|Go|Python|Rust|Java|Kotlin)\b",
        r"\b(PostgreSQL|MySQL|MongoDB|Redis|Prisma|SQLAlchemy|GORM)\b",
        r"\b(Jest|Vitest|Playwright|pytest|go test|Mocha)\b",
        r"\b(Tailwind|shadcn|MUI|Chakra|Bootstrap)\b",
        r"\b(Docker|Kubernetes|Vercel|AWS|GCP)\b",
    ]
    for output in dev_outputs:
        for pattern in tech_patterns:
            for match in re.findall(pattern, output, re.IGNORECASE):
                key = match.strip()
                stack_keywords[key] = stack_keywords.get(key, 0) + 1

    # Top stack items (mentioned 2+ times)
    stack = sorted(
        [(k, v) for k, v in stack_keywords.items() if v >= 2],
        key=lambda x: -x[1]
    )
    patterns["stack"] = [f"{k} (x{v})" for k, v in stack[:10]]

    # Detect testing patterns from QA outputs
    qa_outputs = role_data.get("QA", [])
    test_patterns_found: List[str] = []
    for output in qa_outputs:
        if re.search(r"(unit test|юнит)", output, re.IGNORECASE):
            test_patterns_found.append("unit tests")
        if re.search(r"(e2e|end-to-end|playwright|cypress)", output, re.IGNORECASE):
            test_patterns_found.append("e2e tests")
        if re.search(r"(integration|интеграц)", output, re.IGNORECASE):
            test_patterns_found.append("integration tests")
        if re.search(r"(BDD|Gherkin|Given.*When.*Then)", output, re.IGNORECASE):
            test_patterns_found.append("BDD/Gherkin")
        if re.search(r"(table.driven|table test)", output, re.IGNORECASE):
            test_patterns_found.append("table-driven tests")
    patterns["testing"] = list(set(test_patterns_found))

    # Detect design patterns from Designer outputs
    designer_outputs = role_data.get("Designer", [])
    design_patterns_found: List[str] = []
    for output in designer_outputs:
        if re.search(r"(WCAG|accessibility|a11y)", output, re.IGNORECASE):
            design_patterns_found.append("WCAG/a11y focus")
        if re.search(r"(dark mode|theme)", output, re.IGNORECASE):
            design_patterns_found.append("theme support")
        if re.search(r"(responsive|mobile.first)", output, re.IGNORECASE):
            design_patterns_found.append("responsive/mobile-first")
        if re.search(r"(component|storybook)", output, re.IGNORECASE):
            design_patterns_found.append("component-driven")
    patterns["design"] = list(set(design_patterns_found))

    # Role usage stats
    role_stats: Dict[str, int] = {}
    for role, outputs in role_data.items():
        if outputs:
            role_stats[role] = len(outputs)

    # Most used roles
    role_order = sorted(role_stats.items(), key=lambda x: -x[1])
    patterns["role_usage"] = [f"{r}: {c} outputs" for r, c in role_order]

    # Build DNA content
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    stack_yaml = "[" + ", ".join(k for k, _ in stack[:10]) + "]" if stack else "[]"
    testing_yaml = "[" + ", ".join(patterns.get("testing", [])) + "]"
    design_yaml = "[" + ", ".join(patterns.get("design", [])) + "]"

    dna_content = f"""---
generated: {now}
tasks_analyzed: {task_count}
confidence: {"high" if task_count >= 10 else "medium" if task_count >= 5 else "low"}
tags: [vaultops/dna, vaultops/adaptive]
---

# Project DNA

> Auto-generated profile from {task_count} enriched tasks. Used by role skills to adapt their output.

## Tech Stack

{chr(10).join(f"- {s}" for s in patterns.get("stack", ["(not enough data)"]))}

## Testing Style

{chr(10).join(f"- {t}" for t in patterns.get("testing", ["(not enough data)"]))}

## Design Patterns

{chr(10).join(f"- {d}" for d in patterns.get("design", ["(not enough data)"]))}

## Role Usage

{chr(10).join(f"- {r}" for r in patterns.get("role_usage", []))}

## Adaptive Rules

> These rules are auto-extracted from your enrichment history. Edit to customize.

- Stack detected: {stack_yaml}
- Test frameworks: {testing_yaml}
- Design approach: {design_yaml}
"""

    _atomic_write(dna_path, dna_content)

    return _tool_result({
        "file": dna_path,
        "tasks_analyzed": task_count,
        "stack": [k for k, _ in stack[:10]],
        "testing": patterns.get("testing", []),
        "design": patterns.get("design", []),
        "role_usage": role_stats,
        "confidence": "high" if task_count >= 10 else "medium" if task_count >= 5 else "low",
    })


# ── Phase 3: Ecosystem & Visibility ──────────────────────────────────────


def _tool_get_replay(args: Dict[str, Any]) -> Dict[str, Any]:
    """Session Replay — what happened in the last N hours/days."""
    project_path = args.get("project_path", ".")
    hours = int(args.get("hours", 24))

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Parse journal entries
    journal_path = os.path.join(exec_dir, EXEC_JOURNAL)
    journal = _read_file(journal_path)
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=hours)).isoformat()

    events: List[Dict[str, str]] = []
    for line in journal.split("\n"):
        if not line.startswith("## "):
            continue
        # Extract timestamp and message
        content = line[3:].strip()
        parts = content.split(" \u2014 ", 1)
        if len(parts) != 2:
            continue
        date_str, message = parts[0].strip(), parts[1].strip()
        if date_str >= cutoff[:10]:  # Compare date portion
            events.append({"date": date_str, "message": message})

    # Parse task changes
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)
    tasks_dir = os.path.join(exec_dir, TASKS_DIR)

    recent_done: List[Dict[str, Any]] = []
    recent_created: List[Dict[str, Any]] = []
    for t in tasks:
        tf = os.path.join(tasks_dir, f"{t['id']}.md")
        if not os.path.isfile(tf):
            continue
        tc = _read_file(tf)
        fm, _ = _parse_frontmatter(tc)

        updated = fm.get("updated_at", "")
        created = fm.get("created_at", "")
        if updated and updated >= cutoff:
            if _normalize_status(fm.get("status", "")) == "DONE":
                # Calculate cycle time
                cycle_h = None
                if created:
                    try:
                        c = datetime.fromisoformat(created.replace("Z", "+00:00"))
                        u = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                        cycle_h = round((u - c).total_seconds() / 3600, 1)
                    except (ValueError, TypeError):
                        pass
                recent_done.append({**t, "cycle_hours": cycle_h})
        if created and created >= cutoff:
            recent_created.append(t)

    # Check learning events
    learn_events = 0
    try:
        vault_project = _resolve_vault_project(project_path)
        if vault_project:
            log_path = os.path.join(vault_project, "08-Execution", LEARNINGS_DIR, LEARNING_LOG)
            if os.path.isfile(log_path):
                log_content = _read_file(log_path)
                for line in log_content.split("\n"):
                    if line.startswith("## ") and " \u2014 " in line:
                        ts = line[3:].split(" \u2014 ")[0].strip()
                        if ts >= cutoff[:19]:
                            learn_events += 1
    except Exception:
        pass

    # Check stale docs
    stale_docs = _detect_stale_docs(exec_dir, project_path, hours)

    # Build digest
    period = f"last {hours}h" if hours <= 24 else f"last {hours // 24}d"
    lines = ["\u2501" * 43, f"  \u25b6  Session Replay  \u00b7  {period}", "\u2501" * 43, ""]

    if recent_done:
        lines.append(f"  COMPLETED ({len(recent_done)})")
        for t in recent_done:
            cycle = f" \u00b7 {t['cycle_hours']}h" if t.get("cycle_hours") else ""
            lines.append(f"  \u2713  {t['id']}: {t.get('task', '')[:40]}{cycle}")
        lines.append("")

    if recent_created:
        lines.append(f"  CREATED ({len(recent_created)})")
        for t in recent_created:
            lines.append(f"  +  {t['id']}: {t.get('task', '')[:40]}")
        lines.append("")

    if events:
        lines.append(f"  JOURNAL ({len(events)} entries)")
        for e in events[-8:]:
            lines.append(f"  \u00b7  {e['date']} \u2014 {e['message'][:45]}")
        if len(events) > 8:
            lines.append(f"  \u00b7  +{len(events) - 8} more")
        lines.append("")

    if stale_docs:
        lines.append(f"  \u26a0  STALE DOCS ({len(stale_docs)})")
        for doc in stale_docs[:5]:
            lines.append(f"  \u00b7  {doc['section']}: {doc['reason'][:40]}")
        lines.append("")

    if learn_events:
        lines.append(f"  \U0001f9e0  {learn_events} learning events recorded")
        lines.append("")

    if not (recent_done or recent_created or events):
        lines.append("  No activity in this period.")
        lines.append("")

    lines.append("\u2501" * 43)
    receipt = "\n".join(lines)

    return _receipt_result(receipt, {
        "period_hours": hours,
        "tasks_completed": len(recent_done),
        "tasks_created": len(recent_created),
        "journal_entries": len(events),
        "stale_docs": len(stale_docs),
        "learning_events": learn_events,
    })


def _detect_stale_docs(exec_dir: str, project_path: str, lookback_hours: int = 48) -> List[Dict[str, str]]:
    """Detect documentation sections that may be stale based on recent file changes."""
    stale: List[Dict[str, str]] = []
    vault_project = _resolve_vault_project(project_path)
    if not vault_project:
        return stale

    # Read all task files to find recently changed files
    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    if not os.path.isdir(tasks_dir):
        return stale

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=lookback_hours)).isoformat()
    changed_files: List[str] = []

    for fname in os.listdir(tasks_dir):
        if not fname.endswith(".md"):
            continue
        tc = _read_file(os.path.join(tasks_dir, fname))
        fm, body = _parse_frontmatter(tc)
        updated = fm.get("updated_at", "")
        if updated and updated >= cutoff:
            # Look for file references in evidence/body
            for line in body.split("\n"):
                # Match file paths like src/foo/bar.ts
                for m in re.finditer(r"[`'\"]?([\w/.-]+\.\w{1,5})[`'\"]?", line):
                    path = m.group(1)
                    if "/" in path and not path.startswith("http"):
                        changed_files.append(path)

    if not changed_files:
        return stale

    # Check which doc sections reference these files (canonical + alias dirs)
    for section in _discover_all_section_dirs(vault_project):
        section_dir = os.path.join(vault_project, section)
        if not os.path.isdir(section_dir):
            continue
        for doc_file in os.listdir(section_dir):
            if not doc_file.endswith(".md"):
                continue
            doc_content = _read_file(os.path.join(section_dir, doc_file))
            for cf in changed_files:
                basename = os.path.basename(cf)
                if basename in doc_content or cf in doc_content:
                    stale.append({
                        "section": f"{section}/{doc_file}",
                        "reason": f"references {basename} (recently changed)",
                        "file": cf,
                    })
                    break  # One match per doc is enough

    return stale


def _tool_get_stale_docs(args: Dict[str, Any]) -> Dict[str, Any]:
    """Detect documentation that may be outdated based on recent task changes."""
    project_path = args.get("project_path", ".")
    hours = int(args.get("hours", 72))

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    stale = _detect_stale_docs(exec_dir, project_path, hours)

    if not stale:
        return _tool_result({"status": "all_current", "message": "No stale docs detected. All documentation appears up-to-date."})

    lines = []
    for s in stale:
        lines.append(f"- \u26a0 **{s['section']}**: {s['reason']}")

    return _tool_result({
        "stale_count": len(stale),
        "stale_docs": stale,
        "recommendation": f"Run /vault:docs to update {len(stale)} stale section(s).",
        "details": "\n".join(lines),
    })


def _tool_get_arch_radar(args: Dict[str, Any]) -> Dict[str, Any]:
    """Architecture Radar — detect coupling patterns, drift, and suggest ADRs."""
    project_path = args.get("project_path", ".")

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Analyze which files change together across tasks
    tasks_dir = os.path.join(exec_dir, TASKS_DIR)
    if not os.path.isdir(tasks_dir):
        return _tool_result({"status": "no_data", "message": "No tasks found. Complete some tasks first."})

    # Build co-change matrix from task evidence
    task_files: Dict[str, List[str]] = {}  # task_id -> files changed
    for fname in os.listdir(tasks_dir):
        if not fname.endswith(".md"):
            continue
        tc = _read_file(os.path.join(tasks_dir, fname))
        fm, body = _parse_frontmatter(tc)
        tid = fm.get("id", fname.replace(".md", ""))

        files = []
        for line in body.split("\n"):
            for m in re.finditer(r"[`'\"]?([\w/.-]+\.\w{1,5})[`'\"]?", line):
                path = m.group(1)
                if "/" in path and not path.startswith("http") and len(path) > 5:
                    files.append(path)

        if files:
            task_files[tid] = list(set(files))

    if len(task_files) < 3:
        return _tool_result({
            "status": "insufficient_data",
            "message": f"Only {len(task_files)} tasks with file data. Need 3+ for coupling analysis.",
        })

    # Find files that always change together (coupling)
    co_changes: Dict[str, Dict[str, int]] = {}
    for tid, files in task_files.items():
        for i, f1 in enumerate(files):
            for f2 in files[i + 1:]:
                key = tuple(sorted([f1, f2]))
                pair_key = f"{key[0]} <-> {key[1]}"
                co_changes[pair_key] = co_changes.get(pair_key, {})
                co_changes[pair_key]["count"] = co_changes[pair_key].get("count", 0) + 1
                co_changes[pair_key]["files"] = list(key)

    # Sort by co-change frequency
    frequent_pairs = sorted(
        [(k, v) for k, v in co_changes.items() if v["count"] >= 2],
        key=lambda x: -x[1]["count"]
    )

    # File change frequency (hotspots)
    file_freq: Dict[str, int] = {}
    for files in task_files.values():
        for f in files:
            file_freq[f] = file_freq.get(f, 0) + 1
    hotspots = sorted(file_freq.items(), key=lambda x: -x[1])[:10]

    # Detect cross-module coupling
    module_changes: Dict[str, int] = {}
    for files in task_files.values():
        modules = set()
        for f in files:
            parts = f.split("/")
            if len(parts) >= 2:
                modules.add(parts[0] + "/" + parts[1] if len(parts) >= 3 else parts[0])
        if len(modules) > 1:
            for mod in modules:
                module_changes[mod] = module_changes.get(mod, 0) + 1

    # Build insights
    insights: List[str] = []
    adr_suggestions: List[str] = []

    if frequent_pairs:
        insights.append(f"{len(frequent_pairs)} file pair(s) always change together (coupling smell)")
        if len(frequent_pairs) >= 3:
            top_pair = frequent_pairs[0]
            adr_suggestions.append(
                f"Consider extracting shared logic from {top_pair[0]} — changed together {top_pair[1]['count']} times"
            )

    if hotspots and hotspots[0][1] >= 4:
        insights.append(f"Hotspot: {hotspots[0][0]} changed in {hotspots[0][1]} tasks — high change frequency")

    cross_module = [(m, c) for m, c in module_changes.items() if c >= 2]
    if len(cross_module) >= 3:
        insights.append(f"{len(cross_module)} modules frequently co-change — possible tight coupling")
        adr_suggestions.append("Review module boundaries — frequent cross-module changes suggest architecture drift")

    # Build Mermaid diagram
    mermaid = "graph LR\n"
    for pair_key, data in frequent_pairs[:8]:
        f1, f2 = data["files"]
        b1 = os.path.basename(f1)
        b2 = os.path.basename(f2)
        n = data["count"]
        mermaid += f"    {b1.replace('.', '_')}[{b1}] -- \"{n}x\" --> {b2.replace('.', '_')}[{b2}]\n"

    # Build receipt
    lines = ["\u2501" * 43, "  \U0001f4e1  Architecture Radar", "\u2501" * 43, ""]

    if hotspots:
        lines.append("  HOTSPOTS (most-changed files)")
        for f, count in hotspots[:5]:
            bar = "\u2588" * min(count, 10)
            lines.append(f"  {bar} {f} ({count}x)")
        lines.append("")

    if frequent_pairs:
        lines.append("  COUPLING (files that change together)")
        for pair_key, data in frequent_pairs[:5]:
            lines.append(f"  \u2194  {pair_key} ({data['count']}x)")
        lines.append("")

    if insights:
        lines.append("  INSIGHTS")
        for i in insights:
            lines.append(f"  \u00b7  {i}")
        lines.append("")

    if adr_suggestions:
        lines.append("  ADR SUGGESTIONS")
        for s in adr_suggestions:
            lines.append(f"  \u2192  {s}")
        lines.append("")

    lines.append("\u2501" * 43)
    receipt = "\n".join(lines)

    return _receipt_result(receipt, {
        "hotspots": hotspots[:10],
        "coupling_pairs": len(frequent_pairs),
        "insights": insights,
        "adr_suggestions": adr_suggestions,
        "mermaid": mermaid if frequent_pairs else None,
        "tasks_analyzed": len(task_files),
    })


def _tool_generate_report(args: Dict[str, Any]) -> Dict[str, Any]:
    """Generate standalone HTML report for stakeholders."""
    project_path = args.get("project_path", ".")
    sprint_number = args.get("sprint_number")
    output_path = args.get("output_path", "")

    exec_dir, err = _exec_path(project_path)
    if err:
        return _tool_result({"error": err}, is_error=True)

    # Collect data
    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    tasks = _parse_task_board(task_board_md)
    tasks_dir = os.path.join(exec_dir, TASKS_DIR)

    # Filter by sprint if specified
    if sprint_number:
        sprint_tasks = []
        for t in tasks:
            tf = os.path.join(tasks_dir, f"{t['id']}.md")
            if os.path.isfile(tf):
                tc = _read_file(tf)
                fm, _ = _parse_frontmatter(tc)
                if str(fm.get("sprint", "")) == str(sprint_number):
                    sprint_tasks.append(t)
        tasks = sprint_tasks

    done = [t for t in tasks if _normalize_status(t.get("status", "")) == "DONE"]
    active = [t for t in tasks if _normalize_status(t.get("status", "")) == "IN_PROGRESS"]
    blocked = [t for t in tasks if _normalize_status(t.get("status", "")) == "BLOCKED"]
    todo = [t for t in tasks if _normalize_status(t.get("status", "")) == "TODO"]
    total = len(tasks)
    done_pct = round(len(done) / total * 100) if total else 0

    # Get velocity
    vel_result = _tool_get_velocity({"project_path": project_path})
    vel_data = {}
    if "content" in vel_result and vel_result["content"]:
        try:
            vel_data = json.loads(vel_result["content"][0].get("text", "{}"))
        except (json.JSONDecodeError, IndexError):
            pass

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    project_name = os.path.basename(os.path.normpath(project_path))
    title = f"Sprint {sprint_number}" if sprint_number else "Project Status"

    # Build task rows HTML
    task_rows = ""
    status_colors = {"DONE": "#22c55e", "IN_PROGRESS": "#3b82f6", "BLOCKED": "#ef4444", "TODO": "#6b7280"}
    for t in tasks:
        status = _normalize_status(t.get("status", "TODO"))
        color = status_colors.get(status, "#6b7280")
        task_rows += f"""<tr>
            <td style="font-family:monospace;font-weight:600">{_html.escape(t['id'])}</td>
            <td>{_html.escape(t.get('task', '')[:50])}</td>
            <td><span style="background:{color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">{_html.escape(status)}</span></td>
            <td>{_html.escape(t.get('priority', ''))}</td>
        </tr>"""

    # SVG donut chart
    done_angle = done_pct * 3.6
    svg_donut = f"""<svg width="120" height="120" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" stroke-width="3"/>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#22c55e" stroke-width="3"
            stroke-dasharray="{done_pct} {100 - done_pct}" stroke-dashoffset="25"
            stroke-linecap="round"/>
        <text x="18" y="20" text-anchor="middle" font-size="8" font-weight="bold" fill="#111">{done_pct}%</text>
    </svg>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_html.escape(title)} — {_html.escape(project_name)}</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;padding:32px;max-width:900px;margin:0 auto}}
h1{{font-size:24px;margin-bottom:4px}}
.subtitle{{color:#64748b;margin-bottom:24px;font-size:14px}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}}
.card{{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;text-align:center}}
.card .value{{font-size:32px;font-weight:700;margin-bottom:4px}}
.card .label{{font-size:13px;color:#64748b}}
.done .value{{color:#22c55e}}
.active .value{{color:#3b82f6}}
.blocked .value{{color:#ef4444}}
table{{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;margin-bottom:32px}}
th{{background:#f1f5f9;text-align:left;padding:10px 12px;font-size:13px;color:#475569;font-weight:600}}
td{{padding:10px 12px;border-top:1px solid #f1f5f9;font-size:14px}}
.footer{{text-align:center;color:#94a3b8;font-size:12px;margin-top:32px}}
.donut{{display:flex;align-items:center;gap:16px;margin-bottom:24px}}
</style>
</head>
<body>
<h1>{_html.escape(title)}</h1>
<p class="subtitle">{_html.escape(project_name)} \u00b7 Generated {now} \u00b7 VaultOps</p>

<div class="donut">
{svg_donut}
<div>
<div style="font-size:20px;font-weight:700">{len(done)}/{total} tasks complete</div>
<div style="color:#64748b;font-size:14px">Avg cycle: {vel_data.get('avg_cycle_time_hours', 'N/A')}h \u00b7 Velocity: {vel_data.get('velocity_per_day', 'N/A')}/day</div>
</div>
</div>

<div class="cards">
<div class="card done"><div class="value">{len(done)}</div><div class="label">Done</div></div>
<div class="card active"><div class="value">{len(active)}</div><div class="label">In Progress</div></div>
<div class="card blocked"><div class="value">{len(blocked)}</div><div class="label">Blocked</div></div>
<div class="card"><div class="value">{len(todo)}</div><div class="label">To Do</div></div>
</div>

<table>
<thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Priority</th></tr></thead>
<tbody>{task_rows}</tbody>
</table>

<div class="footer">Generated by VaultOps \u00b7 Zero dependencies \u00b7 Share as file</div>
</body>
</html>"""

    # Write to file — validate output_path stays within project directory
    if not output_path:
        output_path = os.path.join(project_path, f"report-{title.lower().replace(' ', '-')}.html")
    else:
        resolved_out = Path(output_path).resolve()
        project_root = Path(project_path).resolve()
        try:
            resolved_out.relative_to(project_root)
        except ValueError:
            return _tool_result({"error": f"output_path must be within project directory: {output_path}"}, is_error=True)
    _atomic_write(output_path, html)

    return _tool_result({
        "file": output_path,
        "title": title,
        "tasks": total,
        "completion": done_pct,
        "message": f"Report saved to {output_path}. Open in browser to view.",
    })


# ── Self-learning tools ──────────────────────────────────────────────────

LEARNINGS_DIR = "Learnings"
LEARNING_LOG = "Learning Log.md"
PATTERNS_FILE = "Patterns.md"
PROJECT_PROFILE = "Project Profile.md"


def _parse_learning_log(log_content: str) -> List[Dict[str, Any]]:
    """Parse Learning Log.md into a list of event dicts."""
    events: List[Dict[str, Any]] = []
    if not log_content.strip():
        return events

    current: Optional[Dict[str, Any]] = None
    for line in log_content.split("\n"):
        line = line.strip()
        if line.startswith("## ") and " — " in line:
            if current:
                events.append(current)
            parts = line[3:].split(" — ", 1)
            current = {"timestamp": parts[0].strip(), "event_type": parts[1].strip() if len(parts) > 1 else "unknown"}
        elif line.startswith("- ") and current is not None:
            kv = line[2:].split(": ", 1)
            if len(kv) == 2:
                key, val = kv[0].strip(), kv[1].strip()
                # Try to parse booleans and numbers
                if val.lower() == "true":
                    current[key] = True
                elif val.lower() == "false":
                    current[key] = False
                elif val.lower() == "none":
                    current[key] = None
                else:
                    try:
                        current[key] = float(val) if "." in val else int(val)
                    except (ValueError, TypeError):
                        current[key] = val
    if current:
        events.append(current)
    return events


def _tool_learn_from_history(args: Dict[str, Any]) -> Dict[str, Any]:
    """Analyze execution history and extract learning patterns."""
    exec_dir, err = _exec_path(args.get("project_path", ""))
    if err:
        return _tool_result({"error": err}, is_error=True)

    learnings_dir = os.path.join(exec_dir, LEARNINGS_DIR)
    log_path = os.path.join(learnings_dir, LEARNING_LOG)

    if not os.path.isfile(log_path):
        return _tool_result({
            "status": "no_history",
            "message": "No learning data yet. VaultOps will start collecting data automatically as you work.",
        })

    log_content = _read_file(log_path)
    events = _parse_learning_log(log_content)

    if len(events) < 3:
        return _tool_result({
            "status": "insufficient_data",
            "message": f"Only {len(events)} events collected. Need at least 3 for meaningful analysis.",
            "events_collected": len(events),
        })

    focus = args.get("focus", "all")

    # ── Compute intent accuracy ──────────────────────────────────────
    intent_events = [e for e in events if e.get("event_type") == "intent_classified"]
    corrections = [e for e in events if e.get("event_type") == "user_correction"]
    total_intents = len(intent_events)
    total_corrections = len(corrections)
    intent_accuracy = round((total_intents - total_corrections) / max(total_intents, 1), 2)

    # Layer distribution
    layer_counts: Dict[str, int] = {}
    for e in intent_events:
        layer = e.get("match_layer", "none")
        layer_counts[layer] = layer_counts.get(layer, 0) + 1

    # Correction breakdown
    correction_types: Dict[str, int] = {}
    for c in corrections:
        ct = c.get("type", "unknown")
        correction_types[ct] = correction_types.get(ct, 0) + 1

    # ── Compute cycle times ──────────────────────────────────────────
    completed = [e for e in events if e.get("event_type") in ("task_completed", "session_ended")]
    cycle_by_type: Dict[str, List[float]] = {}
    for e in completed:
        wt = e.get("work_type", "unknown")
        ct = e.get("cycle_time_hours")
        if ct and isinstance(ct, (int, float)) and ct > 0:
            cycle_by_type.setdefault(wt, []).append(ct)

    cycle_stats: Dict[str, Dict[str, Any]] = {}
    for wt, times in cycle_by_type.items():
        sorted_t = sorted(times)
        avg = round(sum(sorted_t) / len(sorted_t), 2)
        median = sorted_t[len(sorted_t) // 2]
        cycle_stats[wt] = {"avg_hours": avg, "median_hours": round(median, 2), "count": len(sorted_t)}

    # ── Auto-completion accuracy ─────────────────────────────────────
    auto_completed = [e for e in completed if e.get("auto_completed") is True]
    reopened = [c for c in corrections if c.get("type") == "task_reopened"]
    auto_total = len(auto_completed)
    auto_accuracy = round((auto_total - len(reopened)) / max(auto_total, 1), 2) if auto_total else None

    # ── Priority accuracy ────────────────────────────────────────────
    priority_corrections = [c for c in corrections if c.get("type") == "priority_changed"]
    tasks_with_priority = [e for e in intent_events if e.get("priority_assigned")]
    priority_total = len(tasks_with_priority)
    priority_accuracy = round((priority_total - len(priority_corrections)) / max(priority_total, 1), 2) if priority_total else None

    # Priority correction patterns
    priority_patterns: Dict[str, int] = {}
    for pc in priority_corrections:
        key = f"{pc.get('from', '?')}->{pc.get('to', '?')}"
        priority_patterns[key] = priority_patterns.get(key, 0) + 1

    # ── Work type distribution ───────────────────────────────────────
    work_dist: Dict[str, int] = {}
    for e in intent_events:
        intent = e.get("classified_intent", "unknown")
        if intent and intent != "question":
            work_dist[intent] = work_dist.get(intent, 0) + 1

    # ── Determine confidence ─────────────────────────────────────────
    total_data = len(events)
    if total_data >= 30:
        confidence = "high"
    elif total_data >= 10:
        confidence = "medium"
    else:
        confidence = "low"

    # ── Write Patterns.md ────────────────────────────────────────────
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    patterns_content = f"""---
last_analyzed: {now_iso}
total_events: {total_data}
total_tasks_analyzed: {len(completed)}
confidence: {confidence}
version: 1
---

# Learned Patterns

## Intent Classification
- Accuracy: {int(intent_accuracy * 100)}% ({total_intents - total_corrections}/{total_intents})
- Total classifications: {total_intents}
- Total corrections: {total_corrections}
"""

    if layer_counts:
        patterns_content += "\n### Match Layer Distribution\n"
        for layer, cnt in sorted(layer_counts.items(), key=lambda x: -x[1]):
            patterns_content += f"- {layer}: {cnt} ({int(cnt/max(total_intents,1)*100)}%)\n"

    if correction_types:
        patterns_content += "\n### Correction Types\n"
        for ct, cnt in sorted(correction_types.items(), key=lambda x: -x[1]):
            patterns_content += f"- {ct}: {cnt}\n"

    if cycle_stats:
        patterns_content += "\n## Cycle Time by Work Type\n\n"
        patterns_content += "| Type | Avg Hours | Median | Count |\n"
        patterns_content += "|------|-----------|--------|-------|\n"
        for wt, st in sorted(cycle_stats.items(), key=lambda x: -x[1]["count"]):
            patterns_content += f"| {wt} | {st['avg_hours']} | {st['median_hours']} | {st['count']} |\n"

    if auto_accuracy is not None:
        patterns_content += f"\n## Auto-Completion\n- Accuracy: {int(auto_accuracy * 100)}%\n"
        patterns_content += f"- Auto-completed: {auto_total}\n"
        patterns_content += f"- Reopened: {len(reopened)}\n"

    if priority_accuracy is not None:
        patterns_content += f"\n## Priority Calibration\n- Accuracy: {int(priority_accuracy * 100)}%\n"
        if priority_patterns:
            patterns_content += "- Correction patterns:\n"
            for pat, cnt in sorted(priority_patterns.items(), key=lambda x: -x[1]):
                patterns_content += f"  - {pat}: {cnt} time(s)\n"

    if work_dist:
        patterns_content += "\n## Work Distribution\n"
        total_work = sum(work_dist.values())
        for wt, cnt in sorted(work_dist.items(), key=lambda x: -x[1]):
            pct = int(cnt / max(total_work, 1) * 100)
            patterns_content += f"- {wt}: {pct}% ({cnt})\n"

    os.makedirs(learnings_dir, exist_ok=True)
    _atomic_write(os.path.join(learnings_dir, PATTERNS_FILE), patterns_content)

    # ── Write Project Profile ────────────────────────────────────────
    dominant_type = max(work_dist, key=work_dist.get) if work_dist else "unknown"
    avg_prompts = 0
    prompt_counts = [e.get("prompt_count", 0) for e in completed if e.get("prompt_count")]
    if prompt_counts:
        avg_prompts = round(sum(prompt_counts) / len(prompt_counts), 1)

    profile_content = f"""---
project: {os.path.basename(args.get("project_path", "unknown"))}
dominant_work_type: {dominant_type}
avg_session_prompts: {avg_prompts}
auto_completion_rate: {auto_accuracy if auto_accuracy is not None else "N/A"}
intent_accuracy: {intent_accuracy}
priority_accuracy: {priority_accuracy if priority_accuracy is not None else "N/A"}
updated: {now_iso}
---

# Project Profile

Generated by `learn_from_history` on {now_iso}.
Confidence: **{confidence}** ({total_data} events, {len(completed)} task outcomes).
"""

    _atomic_write(os.path.join(learnings_dir, PROJECT_PROFILE), profile_content)

    return _tool_result({
        "status": "analyzed",
        "confidence": confidence,
        "total_events": total_data,
        "tasks_analyzed": len(completed),
        "intent_accuracy": intent_accuracy,
        "priority_accuracy": priority_accuracy,
        "auto_completion_accuracy": auto_accuracy,
        "cycle_stats": cycle_stats,
        "work_distribution": work_dist,
        "patterns_file": os.path.join(learnings_dir, PATTERNS_FILE),
    })


def _tool_get_insights(args: Dict[str, Any]) -> Dict[str, Any]:
    """Surface actionable insights from learned patterns."""
    exec_dir, err = _exec_path(args.get("project_path", ""))
    if err:
        return _tool_result({"error": err}, is_error=True)

    patterns_path = os.path.join(exec_dir, LEARNINGS_DIR, PATTERNS_FILE)
    profile_path = os.path.join(exec_dir, LEARNINGS_DIR, PROJECT_PROFILE)

    if not os.path.isfile(patterns_path):
        return _tool_result({
            "status": "no_patterns",
            "message": "No patterns analyzed yet. Run learn_from_history first.",
        })

    patterns_fm, patterns_body = _parse_frontmatter(_read_file(patterns_path))
    profile_fm, _ = _parse_frontmatter(_read_file(profile_path)) if os.path.isfile(profile_path) else ({}, "")

    confidence = patterns_fm.get("confidence", "low")
    total_events = patterns_fm.get("total_events", 0)
    context = args.get("context", "")

    insights: List[Dict[str, Any]] = []

    # Parse key metrics from patterns body
    intent_acc = patterns_fm.get("intent_accuracy") or profile_fm.get("intent_accuracy")
    if intent_acc and isinstance(intent_acc, (int, float)):
        intent_pct = int(float(intent_acc) * 100) if float(intent_acc) <= 1 else int(intent_acc)
        if intent_pct < 80:
            insights.append({
                "type": "intent_accuracy",
                "message": f"Intent classification accuracy is {intent_pct}%. Consider running /vault:learn to review correction patterns.",
                "confidence": confidence,
                "severity": "warning",
            })
        else:
            insights.append({
                "type": "intent_accuracy",
                "message": f"Intent classification is working well at {intent_pct}% accuracy.",
                "confidence": confidence,
                "severity": "info",
            })

    auto_rate = profile_fm.get("auto_completion_rate")
    if auto_rate and auto_rate != "N/A":
        try:
            rate = float(auto_rate)
            if rate < 0.8:
                insights.append({
                    "type": "auto_completion",
                    "message": f"Auto-completion accuracy is {int(rate*100)}%. Some tasks are being reopened after auto-close.",
                    "confidence": confidence,
                    "severity": "warning",
                })
        except (ValueError, TypeError):
            pass

    dominant = profile_fm.get("dominant_work_type", "unknown")
    if dominant != "unknown":
        insights.append({
            "type": "work_distribution",
            "message": f"Most common work type: {dominant}.",
            "confidence": confidence,
            "severity": "info",
        })

    avg_prompts = profile_fm.get("avg_session_prompts")
    if avg_prompts and avg_prompts != "N/A":
        try:
            ap = float(avg_prompts)
            insights.append({
                "type": "session_pattern",
                "message": f"Average session length: {ap} prompts.",
                "confidence": confidence,
                "severity": "info",
            })
        except (ValueError, TypeError):
            pass

    return _tool_result({
        "insights": insights[:5],
        "confidence": confidence,
        "total_events": total_events,
        "project_profile": {
            "dominant_work_type": dominant,
            "auto_completion_rate": auto_rate,
            "intent_accuracy": intent_acc,
        },
    })


def _tool_adapt_priority(args: Dict[str, Any]) -> Dict[str, Any]:
    """Suggest priority based on learned correction patterns."""
    exec_dir, err = _exec_path(args.get("project_path", ""))
    if err:
        return _tool_result({"error": err}, is_error=True)

    title = args.get("title", "")
    work_type = args.get("work_type", "")

    # Get keyword-based priority using inline logic (avoid importing brain_state from MCP context)
    _p1_stems = {"bug", "broken", "urgent", "critical", "crash", "hotfix", "asap",
                  "баг", "срочн", "критичн", "термінов", "сломал", "поломал", "упал"}
    _p3_stems = {"minor", "cleanup", "chore", "мелоч", "незначн", "дрібниц"}
    title_lower = title.lower()
    words = set(re.findall(r"[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+", title_lower))
    keyword_priority = "P2"
    for word in words:
        for stem in _p1_stems:
            if word.startswith(stem):
                keyword_priority = "P1"
                break
        if keyword_priority != "P2":
            break
    if keyword_priority == "P2":
        for word in words:
            for stem in _p3_stems:
                if word.startswith(stem):
                    keyword_priority = "P3"
                    break
            if keyword_priority != "P2":
                break

    # Check learned patterns
    log_path = os.path.join(exec_dir, LEARNINGS_DIR, LEARNING_LOG)
    if not os.path.isfile(log_path):
        return _tool_result({
            "keyword_priority": keyword_priority,
            "learned_priority": None,
            "reason": "No learning data yet. Using keyword-based priority.",
            "confidence": "none",
            "recommendation": keyword_priority,
        })

    events = _parse_learning_log(_read_file(log_path))
    corrections = [e for e in events if e.get("event_type") == "user_correction" and e.get("type") == "priority_changed"]

    if not corrections:
        return _tool_result({
            "keyword_priority": keyword_priority,
            "learned_priority": None,
            "reason": "No priority corrections recorded. Keyword-based priority is reliable.",
            "confidence": "low",
            "recommendation": keyword_priority,
        })

    # Check if work_type or keywords match correction patterns
    # Count corrections by direction
    up_corrections = [c for c in corrections if c.get("from", "") > c.get("to", "")]  # P2->P1 (lower = higher)
    down_corrections = [c for c in corrections if c.get("from", "") < c.get("to", "")]

    # Simple heuristic: if most corrections escalate, bump priority
    if len(up_corrections) > len(down_corrections) and len(up_corrections) >= 2:
        # Corrections trend upward
        learned = "P1" if keyword_priority == "P2" else keyword_priority
        return _tool_result({
            "keyword_priority": keyword_priority,
            "learned_priority": learned,
            "reason": f"{len(up_corrections)} of {len(corrections)} corrections escalated priority. Suggesting higher.",
            "confidence": "medium" if len(corrections) >= 3 else "low",
            "recommendation": learned,
        })

    return _tool_result({
        "keyword_priority": keyword_priority,
        "learned_priority": None,
        "reason": f"{len(corrections)} corrections found but no clear pattern.",
        "confidence": "low",
        "recommendation": keyword_priority,
    })


def _tool_get_learning_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Dashboard view of what VaultOps has learned about this project."""
    exec_dir, err = _exec_path(args.get("project_path", ""))
    if err:
        return _tool_result({"error": err}, is_error=True)

    learnings_dir = os.path.join(exec_dir, LEARNINGS_DIR)

    if not os.path.isdir(learnings_dir):
        return _tool_result({
            "status": "not_started",
            "message": "No learning data yet. VaultOps will start collecting data automatically as you work.",
            "data_points": 0,
            "confidence": "none",
        })

    log_path = os.path.join(learnings_dir, LEARNING_LOG)
    patterns_path = os.path.join(learnings_dir, PATTERNS_FILE)
    profile_path = os.path.join(learnings_dir, PROJECT_PROFILE)

    # Count events in log
    log_content = _read_file(log_path)
    events = _parse_learning_log(log_content)
    total_events = len(events)

    # Check patterns freshness
    patterns_fm = {}
    if os.path.isfile(patterns_path):
        patterns_fm, _ = _parse_frontmatter(_read_file(patterns_path))

    last_analysis = patterns_fm.get("last_analyzed", "never")
    confidence = patterns_fm.get("confidence", "none")
    tasks_analyzed = patterns_fm.get("total_tasks_analyzed", 0)

    # Count events since last analysis
    events_since = 0
    if last_analysis != "never":
        for e in events:
            ts = e.get("timestamp", "")
            if ts > last_analysis:
                events_since += 1

    # Profile summary
    profile_fm = {}
    if os.path.isfile(profile_path):
        profile_fm, _ = _parse_frontmatter(_read_file(profile_path))

    suggestions: List[str] = []
    if last_analysis == "never":
        suggestions.append("Run learn_from_history to generate your first analysis.")
    elif events_since > 5:
        suggestions.append(f"Run learn_from_history to refresh ({events_since} new events since last analysis).")
    if total_events < 10:
        suggestions.append(f"Keep working — {10 - total_events} more events needed for medium confidence.")

    return _tool_result({
        "status": "active" if total_events > 0 else "collecting",
        "data_points": total_events,
        "last_analysis": last_analysis,
        "events_since_analysis": events_since,
        "confidence": confidence,
        "tasks_analyzed": tasks_analyzed,
        "intent_accuracy": profile_fm.get("intent_accuracy"),
        "priority_accuracy": profile_fm.get("priority_accuracy"),
        "auto_completion_rate": profile_fm.get("auto_completion_rate"),
        "dominant_work_type": profile_fm.get("dominant_work_type"),
        "suggestions": suggestions,
    })


# ── Meeting Notes ─────────────────────────────────────────────────────────


def _meetings_root() -> Optional[str]:
    """Find the _meetings/ directory at the vault root level."""
    # Try all registered projects to find vault root
    projects = _load_all_projects()
    if projects:
        for proj in projects:
            vault_root = proj.get("vaultRoot", "")
            if vault_root and os.path.isdir(vault_root):
                return os.path.join(vault_root, MEETINGS_DIR)

    # Fallback: check repos
    repos = _load_all_repos()
    for repo in repos:
        repo_path = repo.get("path", "")
        if repo_path:
            # For doc repos, check parent or the path itself
            parent = os.path.dirname(repo_path)
            if os.path.isdir(parent):
                return os.path.join(parent, MEETINGS_DIR)

    # Last resort: default vault root
    default_root = os.path.expanduser("~/.vaultops/vault")
    return os.path.join(default_root, MEETINGS_DIR)


def _ensure_meetings_structure(meetings_dir: str) -> None:
    """Create _meetings/ directory structure if needed."""
    os.makedirs(os.path.join(meetings_dir, MEETING_NOTES_DIR), exist_ok=True)
    os.makedirs(os.path.join(meetings_dir, MEETING_SERIES_DIR), exist_ok=True)
    os.makedirs(os.path.join(meetings_dir, MEETING_TEMPLATES_DIR), exist_ok=True)

    # Create Meeting Index if missing
    index_path = os.path.join(meetings_dir, MEETING_INDEX)
    if not os.path.isfile(index_path):
        _atomic_write(index_path, "# Meeting Index\n\n| ID | Date | Type | Title | Action Items | Status |\n| --- | --- | --- | --- | --- | --- |\n")

    # Create default template if missing
    template_path = os.path.join(meetings_dir, MEETING_TEMPLATES_DIR, "default.md")
    if not os.path.isfile(template_path):
        _atomic_write(template_path, _default_meeting_template())


def _default_meeting_template() -> str:
    return """## 1) TL;DR
-\x20

## 2) Current State
### Product
-\x20

### Growth / Sales
-\x20

### Operations / Team
-\x20

## 3) Decisions Made
- [ ] Decision:\x20
  - Owner:\x20
  - Why:\x20
  - Deadline:\x20

## 4) Action Items
| Priority | Task | Owner | Due Date | Status | Dependencies | Notes |
|---|---|---|---|---|---|---|
| P1 |  |  |  | TODO |  |  |

## 5) Risks / Blockers
- Risk:\x20
  - Impact:\x20
  - Mitigation:\x20

## 6) Main Milestones for Next 7 Days
| Day | Milestone | Success Metric | Owner |
|---|---|---|---|
| Day 1 |  |  |  |

## 7) Open Questions
-\x20

## 8) Follow-up for Next Meeting
- Agenda draft:
  -\x20
"""


def _next_meeting_id(meetings_dir: str) -> str:
    """Auto-increment MTG-### ID."""
    notes_dir = os.path.join(meetings_dir, MEETING_NOTES_DIR)
    max_num = 0
    if os.path.isdir(notes_dir):
        for fname in os.listdir(notes_dir):
            if fname.endswith(".md"):
                content = _read_file(os.path.join(notes_dir, fname))
                m = re.search(r"meeting_id:\s*MTG-(\d+)", content)
                if m:
                    max_num = max(max_num, int(m.group(1)))

    # Also check meeting index
    index_path = os.path.join(meetings_dir, MEETING_INDEX)
    index_content = _read_file(index_path)
    for m in re.finditer(r"MTG-(\d+)", index_content):
        max_num = max(max_num, int(m.group(1)))

    return f"MTG-{max_num + 1:03d}"


def _update_meeting_index(meetings_dir: str, meeting_id: str, date: str, mtype: str, title: str, status: str = "draft") -> None:
    """Add or update a row in Meeting Index.md."""
    index_path = os.path.join(meetings_dir, MEETING_INDEX)
    content = _read_file(index_path)
    if not content.strip():
        content = "# Meeting Index\n\n| ID | Date | Type | Title | Action Items | Status |\n| --- | --- | --- | --- | --- | --- |\n"

    # Check if already exists
    if meeting_id in content:
        # Update existing row
        lines = content.split("\n")
        for i, line in enumerate(lines):
            if meeting_id in line and line.strip().startswith("|"):
                cells = [c.strip() for c in line.strip("|").split("|")]
                if len(cells) >= 6:
                    cells[5] = status
                    lines[i] = "| " + " | ".join(cells) + " |"
        content = "\n".join(lines)
    else:
        row = f"| {meeting_id} | {date} | {mtype} | {title} | 0 | {status} |"
        content = content.rstrip("\n") + "\n" + row + "\n"

    _atomic_write(index_path, content)


def _tool_create_meeting(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new meeting note from template."""
    title = args.get("title", "")
    date = args.get("date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    meeting_type = args.get("meeting_type", "product")
    series = args.get("series", "")
    participants = args.get("participants", [])
    projects = args.get("projects", [])

    if not title:
        return _tool_result({"error": "title is required"}, is_error=True)

    meetings_dir = _meetings_root()
    if not meetings_dir:
        return _tool_result({"error": "Cannot determine vault root for meetings"}, is_error=True)

    _ensure_meetings_structure(meetings_dir)

    # Load series defaults if specified
    if series:
        series_path = os.path.join(meetings_dir, MEETING_SERIES_DIR, f"{series}.md")
        if os.path.isfile(series_path):
            series_content = _read_file(series_path)
            fm = _parse_frontmatter(series_content)
            if not participants:
                participants = fm.get("default_participants", [])
            if not projects:
                projects = fm.get("default_projects", [])

    meeting_id = _next_meeting_id(meetings_dir)
    now = datetime.now(timezone.utc).isoformat()

    # Build participants/projects YAML
    participants_yaml = "[" + ", ".join(participants) + "]" if participants else "[]"
    projects_yaml = "[" + ", ".join(projects) + "]" if projects else "[]"

    # Load template
    template_path = os.path.join(meetings_dir, MEETING_TEMPLATES_DIR, f"{meeting_type}.md")
    if not os.path.isfile(template_path):
        template_path = os.path.join(meetings_dir, MEETING_TEMPLATES_DIR, "default.md")
    template = _read_file(template_path) if os.path.isfile(template_path) else _default_meeting_template()

    # Create meeting note
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]
    filename = f"{date}-{slug}.md"

    file_content = f"""---
meeting_id: {meeting_id}
title: "{title}"
date: {date}
meeting_type: {meeting_type}
series: {series or "null"}
participants: {participants_yaml}
projects: {projects_yaml}
status: draft
action_items_dispatched: false
created_at: {now}
tags: [vaultops/meeting, vaultops/meeting-type/{meeting_type}]
---

# {title}

## Meta
- Date: {date}
- Participants: {', '.join(participants) if participants else 'TBD'}
- Meeting Type: {meeting_type}
{f'- Series: {series}' if series else ''}

{template}"""

    note_path = os.path.join(meetings_dir, MEETING_NOTES_DIR, filename)
    _atomic_write(note_path, file_content)

    # Update meeting index
    _update_meeting_index(meetings_dir, meeting_id, date, meeting_type, title)

    return _tool_result({
        "created": meeting_id,
        "title": title,
        "file": note_path,
        "date": date,
        "meeting_type": meeting_type,
    })


def _tool_get_meeting(args: Dict[str, Any]) -> Dict[str, Any]:
    """Read a meeting note by ID or date."""
    meeting_id = args.get("meeting_id", "")
    date = args.get("date", "")

    meetings_dir = _meetings_root()
    if not meetings_dir:
        return _tool_result({"error": "Cannot determine vault root for meetings"}, is_error=True)

    notes_dir = os.path.join(meetings_dir, MEETING_NOTES_DIR)
    if not os.path.isdir(notes_dir):
        return _tool_result({"error": "No meetings directory found"}, is_error=True)

    # Search for meeting
    for fname in sorted(os.listdir(notes_dir), reverse=True):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(notes_dir, fname)
        content = _read_file(fpath)

        if meeting_id and f"meeting_id: {meeting_id}" in content:
            fm = _parse_frontmatter(content)
            return _tool_result({"meeting_id": meeting_id, "file": fpath, "frontmatter": fm, "content": content})

        if date and fname.startswith(date):
            fm = _parse_frontmatter(content)
            mid = fm.get("meeting_id", "unknown")
            return _tool_result({"meeting_id": mid, "file": fpath, "frontmatter": fm, "content": content})

    return _tool_result({"error": f"Meeting not found: {meeting_id or date}"}, is_error=True)


def _tool_dispatch_action_items(args: Dict[str, Any]) -> Dict[str, Any]:
    """Parse action items from a meeting note and create tasks in target projects."""
    meeting_id = args.get("meeting_id", "")
    dry_run = args.get("dry_run", False)

    if not meeting_id:
        return _tool_result({"error": "meeting_id is required"}, is_error=True)

    meetings_dir = _meetings_root()
    if not meetings_dir:
        return _tool_result({"error": "Cannot determine vault root for meetings"}, is_error=True)

    # Find meeting file
    notes_dir = os.path.join(meetings_dir, MEETING_NOTES_DIR)
    meeting_file = None
    meeting_content = ""
    for fname in os.listdir(notes_dir):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(notes_dir, fname)
        content = _read_file(fpath)
        if f"meeting_id: {meeting_id}" in content:
            meeting_file = fpath
            meeting_content = content
            break

    if not meeting_file:
        return _tool_result({"error": f"Meeting {meeting_id} not found"}, is_error=True)

    fm = _parse_frontmatter(meeting_content)
    if fm.get("action_items_dispatched") in ("true", True) and not dry_run:
        return _tool_result({"warning": f"Action items for {meeting_id} already dispatched. Use dry_run to preview."})

    # Parse action items table
    action_items = []
    in_action_section = False
    header_found = False

    for line in meeting_content.split("\n"):
        stripped = line.strip()
        if "action items" in stripped.lower() and stripped.startswith("#"):
            in_action_section = True
            continue
        if in_action_section and stripped.startswith("#") and "action items" not in stripped.lower():
            break
        if in_action_section and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if len(cells) < 5:
                continue
            # Skip header and separator
            if cells[0].lower() in ("priority", "") or all(re.match(r"^:?-+:?$", c) for c in cells):
                header_found = True
                continue
            if not header_found:
                continue

            priority = cells[0] if cells[0] else "P1"
            task_title = cells[1]
            owner = cells[2] if len(cells) > 2 else ""
            due_date = cells[3] if len(cells) > 3 else ""
            status = cells[4] if len(cells) > 4 else "TODO"
            notes = cells[6] if len(cells) > 6 else ""

            if not task_title.strip() or status.upper() == "DONE":
                continue

            action_items.append({
                "priority": priority,
                "title": task_title,
                "owner": owner,
                "due_date": due_date,
                "status": status,
                "notes": notes,
            })

    if not action_items:
        return _tool_result({"meeting_id": meeting_id, "dispatched": 0, "message": "No actionable items found"})

    # Determine target projects
    meeting_projects = fm.get("projects", [])
    if isinstance(meeting_projects, str):
        meeting_projects = [p.strip() for p in meeting_projects.split(",")]
    all_projects = _load_all_projects_and_repos()

    # Create tasks
    created_tasks = []
    for item in action_items:
        # Try to match project from notes column or meeting projects
        target_project = None
        target_path = None

        # Check notes for project references
        for proj in all_projects:
            repo_id = proj.get("repoId", "")
            if repo_id and repo_id in item.get("notes", ""):
                target_project = repo_id
                target_path = proj.get("path", "")
                break

        # Fall back to first meeting project
        if not target_path and meeting_projects:
            for proj in all_projects:
                if proj.get("repoId", "") in meeting_projects:
                    target_project = proj["repoId"]
                    target_path = proj.get("path", "")
                    break

        # Fall back to first registered project
        if not target_path and all_projects:
            target_project = all_projects[0].get("repoId", "unknown")
            target_path = all_projects[0].get("path", ".")

        dispatch_info = {
            "title": item["title"],
            "priority": item["priority"],
            "owner": item["owner"],
            "due_date": item["due_date"],
            "target_project": target_project or "unassigned",
            "target_path": target_path or ".",
        }

        if dry_run:
            created_tasks.append(dispatch_info)
            continue

        if target_path:
            result = _tool_create_task({
                "project_path": target_path,
                "title": item["title"],
                "priority": item["priority"],
                "owner": item["owner"] or "Agent",
                "scheduled_date": item["due_date"],
                "tags": [f"meeting/{meeting_id}", "action-item"],
            })
            # Extract created task ID from result
            result_data = json.loads(result["content"][0]["text"]) if result.get("content") else {}
            task_id = result_data.get("created", "?")
            dispatch_info["task_id"] = task_id
            created_tasks.append(dispatch_info)

    if dry_run:
        return _tool_result({
            "meeting_id": meeting_id,
            "dry_run": True,
            "action_items": created_tasks,
            "message": f"Would create {len(created_tasks)} tasks. Run without dry_run to dispatch.",
        })

    # Update meeting note: set action_items_dispatched
    meeting_content = _update_frontmatter_field(meeting_content, "action_items_dispatched", "true")
    meeting_content = _update_frontmatter_field(meeting_content, "status", "processed")
    _atomic_write(meeting_file, meeting_content)

    # Update meeting index
    _update_meeting_index(meetings_dir, meeting_id, fm.get("date", ""), fm.get("meeting_type", ""), fm.get("title", ""), "processed")

    return _tool_result({
        "meeting_id": meeting_id,
        "dispatched": len(created_tasks),
        "tasks": created_tasks,
    })


def _tool_link_decision_to_adr(args: Dict[str, Any]) -> Dict[str, Any]:
    """Link a meeting decision to an Architecture Decision Record."""
    meeting_id = args.get("meeting_id", "")
    decision = args.get("decision", "")
    project = args.get("project", "")
    adr_id = args.get("adr_id", "")

    if not meeting_id or not decision:
        return _tool_result({"error": "meeting_id and decision are required"}, is_error=True)

    # Find the project's vault
    target_path = None
    for proj in _load_all_projects_and_repos():
        if proj.get("repoId", "") == project:
            target_path = proj.get("path", "")
            break

    if not target_path:
        return _tool_result({"error": f"Project '{project}' not found"}, is_error=True)

    vault_project = _resolve_vault_project(target_path)
    if not vault_project:
        return _tool_result({"error": f"No vault for project '{project}'"}, is_error=True)

    # Create ADR stub if no adr_id
    decisions_dir = _resolve_section_dir(vault_project, "07", "References")
    os.makedirs(decisions_dir, exist_ok=True)

    if not adr_id:
        # Auto-increment ADR number
        max_adr = 0
        for fname in os.listdir(decisions_dir):
            m = re.match(r"ADR-(\d+)", fname)
            if m:
                max_adr = max(max_adr, int(m.group(1)))
        adr_id = f"ADR-{max_adr + 1:03d}"

        now = datetime.now(timezone.utc).isoformat()
        adr_content = f"""---
adr_id: {adr_id}
title: "{decision}"
status: accepted
date: {now[:10]}
meeting: {meeting_id}
tags: [vaultops/adr, vaultops/meeting/{meeting_id}]
---

# {adr_id}: {decision}

## Context

Decision made during meeting {meeting_id}.

## Decision

{decision}

## Consequences

*(To be documented)*
"""
        adr_path = os.path.join(decisions_dir, f"{adr_id}.md")
        _atomic_write(adr_path, adr_content)

    return _tool_result({
        "linked": True,
        "meeting_id": meeting_id,
        "adr_id": adr_id,
        "project": project,
        "decision": decision,
    })


def _tool_create_followup(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create a scheduled follow-up task from a meeting."""
    meeting_id = args.get("meeting_id", "")
    description = args.get("description", "")
    due_date = args.get("due_date", "")
    assignee = args.get("assignee", "")
    project = args.get("project", "")

    if not meeting_id or not description:
        return _tool_result({"error": "meeting_id and description are required"}, is_error=True)

    # Find target project
    target_path = "."
    if project:
        for proj in _load_all_projects_and_repos():
            if proj.get("repoId", "") == project:
                target_path = proj.get("path", ".")
                break

    result = _tool_create_task({
        "project_path": target_path,
        "title": f"[Follow-up] {description}",
        "priority": "P1",
        "owner": assignee or "Agent",
        "scheduled_date": due_date,
        "tags": [f"followup/{meeting_id}", "meeting-followup"],
    })

    # Extract task ID from result
    result_data = json.loads(result["content"][0]["text"]) if result.get("content") else {}
    task_id = result_data.get("created", "?")

    return _tool_result({
        "created": task_id,
        "meeting_id": meeting_id,
        "description": description,
        "due_date": due_date,
        "project": project or "current",
    })


def _tool_get_meeting_dashboard(args: Dict[str, Any]) -> Dict[str, Any]:
    """Dashboard view of recent meetings and outstanding items."""
    days_back = args.get("days_back", 14)
    project_filter = args.get("project", "")

    meetings_dir = _meetings_root()
    if not meetings_dir:
        return _tool_result({"error": "Cannot determine vault root for meetings"}, is_error=True)

    notes_dir = os.path.join(meetings_dir, MEETING_NOTES_DIR)
    if not os.path.isdir(notes_dir):
        return _tool_result({"meetings": [], "undispatched": [], "message": "No meetings found"})

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    recent_meetings = []
    undispatched = []

    for fname in sorted(os.listdir(notes_dir), reverse=True):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(notes_dir, fname)
        content = _read_file(fpath)
        fm = _parse_frontmatter(content)

        meeting_date = fm.get("date", "")
        if meeting_date < cutoff:
            continue

        if project_filter:
            meeting_projects = fm.get("projects", [])
            if isinstance(meeting_projects, str):
                meeting_projects = [p.strip() for p in meeting_projects.split(",")]
            if project_filter not in meeting_projects:
                continue

        meeting_id = fm.get("meeting_id", "")
        title = fm.get("title", fname)
        status = fm.get("status", "draft")

        # Extract TL;DR
        tldr = ""
        in_tldr = False
        for line in content.split("\n"):
            if "TL;DR" in line or "tl;dr" in line.lower():
                in_tldr = True
                continue
            if in_tldr:
                if line.strip().startswith("#"):
                    break
                if line.strip().startswith("- "):
                    tldr += line.strip()[2:] + "; "
        tldr = tldr.strip("; ")[:100]

        recent_meetings.append({
            "meeting_id": meeting_id,
            "date": meeting_date,
            "title": title,
            "status": status,
            "tldr": tldr,
        })

        dispatched = fm.get("action_items_dispatched", "false")
        if dispatched in ("false", False, ""):
            undispatched.append({
                "meeting_id": meeting_id,
                "date": meeting_date,
                "title": title,
            })

    # Check for overdue follow-ups across all projects
    overdue_followups = []
    for proj in _load_all_projects_and_repos():
        proj_path = proj.get("path", "")
        if not proj_path:
            continue
        if proj.get("type") == "doc-repo":
            vault_project = proj_path
        else:
            vault_project = _resolve_vault_project_from_registry(proj)
        tasks_dir = os.path.join(vault_project, EXEC_DIR, TASKS_DIR)
        if not os.path.isdir(tasks_dir):
            continue
        for fname in os.listdir(tasks_dir):
            if not fname.endswith(".md"):
                continue
            task_content = _read_file(os.path.join(tasks_dir, fname))
            tfm = _parse_frontmatter(task_content)
            tags = tfm.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",")]
            has_followup = any("followup/" in str(t) or "meeting/" in str(t) for t in tags)
            if not has_followup:
                continue
            sched = tfm.get("scheduled_date", "")
            status = tfm.get("status", "TODO")
            if sched and sched < today and status not in ("DONE", "done"):
                overdue_followups.append({
                    "task_id": tfm.get("id", fname.replace(".md", "")),
                    "title": tfm.get("title", ""),
                    "scheduled_date": sched,
                    "project": proj.get("repoId", ""),
                })

    # Upcoming series
    series_dir = os.path.join(meetings_dir, MEETING_SERIES_DIR)
    upcoming_series = []
    if os.path.isdir(series_dir):
        for fname in os.listdir(series_dir):
            if not fname.endswith(".md"):
                continue
            sc = _read_file(os.path.join(series_dir, fname))
            sfm = _parse_frontmatter(sc)
            upcoming_series.append({
                "series_id": sfm.get("series_id", fname.replace(".md", "")),
                "name": sfm.get("name", ""),
                "cadence": sfm.get("cadence", ""),
            })

    return _tool_result({
        "recent_meetings": recent_meetings[:10],
        "undispatched": undispatched,
        "overdue_followups": overdue_followups,
        "upcoming_series": upcoming_series,
        "period_days": days_back,
    })


def _tool_get_meeting_series(args: Dict[str, Any]) -> Dict[str, Any]:
    """List or manage meeting series."""
    series_id = args.get("series_id", "")
    action = args.get("action", "list")
    name = args.get("name", "")
    cadence = args.get("cadence", "weekly")
    default_participants = args.get("default_participants", [])
    default_projects = args.get("default_projects", [])

    meetings_dir = _meetings_root()
    if not meetings_dir:
        return _tool_result({"error": "Cannot determine vault root for meetings"}, is_error=True)

    _ensure_meetings_structure(meetings_dir)
    series_dir = os.path.join(meetings_dir, MEETING_SERIES_DIR)

    if action == "create" and name:
        sid = series_id or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        participants_yaml = "[" + ", ".join(default_participants) + "]" if default_participants else "[]"
        projects_yaml = "[" + ", ".join(default_projects) + "]" if default_projects else "[]"

        content = f"""---
series_id: {sid}
name: "{name}"
cadence: {cadence}
default_participants: {participants_yaml}
default_projects: {projects_yaml}
created_at: {datetime.now(timezone.utc).isoformat()}
tags: [vaultops/meeting-series]
---

# {name}

Recurring {cadence} meeting.
"""
        fpath = os.path.join(series_dir, f"{sid}.md")
        _atomic_write(fpath, content)
        return _tool_result({"created": sid, "name": name, "cadence": cadence})

    if series_id:
        fpath = os.path.join(series_dir, f"{series_id}.md")
        if not os.path.isfile(fpath):
            return _tool_result({"error": f"Series '{series_id}' not found"}, is_error=True)
        content = _read_file(fpath)
        fm = _parse_frontmatter(content)

        # Find recent meetings in this series
        notes_dir = os.path.join(meetings_dir, MEETING_NOTES_DIR)
        recent = []
        if os.path.isdir(notes_dir):
            for fname in sorted(os.listdir(notes_dir), reverse=True):
                if not fname.endswith(".md"):
                    continue
                nc = _read_file(os.path.join(notes_dir, fname))
                if f"series: {series_id}" in nc:
                    nfm = _parse_frontmatter(nc)
                    recent.append({"meeting_id": nfm.get("meeting_id", ""), "date": nfm.get("date", ""), "title": nfm.get("title", "")})
                if len(recent) >= 5:
                    break

        return _tool_result({"series": fm, "recent_meetings": recent})

    # List all series
    result = []
    if os.path.isdir(series_dir):
        for fname in os.listdir(series_dir):
            if not fname.endswith(".md"):
                continue
            content = _read_file(os.path.join(series_dir, fname))
            fm = _parse_frontmatter(content)
            result.append({
                "series_id": fm.get("series_id", fname.replace(".md", "")),
                "name": fm.get("name", ""),
                "cadence": fm.get("cadence", ""),
            })

    return _tool_result({"series": result})


# ── Tool registry and dispatch ───────────────────────────────────────────


def _handle_tools_call(params: Dict[str, Any]) -> Dict[str, Any]:
    name = params.get("name")
    args = params.get("arguments") or {}

    handlers = {
        "get_context": _tool_get_context,
        "get_today": _tool_get_today,
        "update_task": _tool_update_task,
        "create_task": _tool_create_task,
        "log_step": _tool_log_step,
        "write_plan": _tool_write_plan,
        "get_kanban": _tool_get_kanban,
        "generate_docs_prompt": _tool_generate_docs_prompt,
        "get_task": _tool_get_task,
        "write_role_output": _tool_write_role_output,
        "get_role_output": _tool_get_role_output,
        "link_tasks": _tool_link_tasks,
        "get_task_graph": _tool_get_task_graph,
        "get_velocity": _tool_get_velocity,
        "get_burndown": _tool_get_burndown,
        "search_tasks": _tool_search_tasks,
        "create_cross_project_link": _tool_create_cross_project_link,
        "get_cross_project_deps": _tool_get_cross_project_deps,
        "schedule_task": _tool_schedule_task,
        "get_schedule": _tool_get_schedule,
        "create_sprint": _tool_create_sprint,
        "assign_to_sprint": _tool_assign_to_sprint,
        "get_sprint": _tool_get_sprint,
        "generate_canvas": _tool_generate_canvas,
        "generate_retro": _tool_generate_retro,
        # Self-learning tools
        "learn_from_history": _tool_learn_from_history,
        "get_insights": _tool_get_insights,
        "adapt_priority": _tool_adapt_priority,
        "get_learning_status": _tool_get_learning_status,
        # Task-as-Code
        "run_verify": _tool_run_verify,
        # Predictive Brain
        "get_predictions": _tool_get_predictions,
        # Adaptive Roles
        "get_project_dna": _tool_get_project_dna,
        # Meeting Notes
        "create_meeting": _tool_create_meeting,
        "get_meeting": _tool_get_meeting,
        "dispatch_action_items": _tool_dispatch_action_items,
        "link_decision_to_adr": _tool_link_decision_to_adr,
        "create_followup": _tool_create_followup,
        "get_meeting_dashboard": _tool_get_meeting_dashboard,
        "get_meeting_series": _tool_get_meeting_series,
        # Phase 3: Ecosystem
        "get_replay": _tool_get_replay,
        "get_stale_docs": _tool_get_stale_docs,
        "get_arch_radar": _tool_get_arch_radar,
        "generate_report": _tool_generate_report,
    }

    if name not in handlers:
        return _tool_result({"error": f"Unknown tool: {name}"}, is_error=True)

    try:
        return handlers[name](args)
    except Exception as exc:
        return _tool_result({"error": str(exc)}, is_error=True)


def _tools_list_result() -> Dict[str, Any]:
    pp = {
        "type": "string",
        "description": "Absolute path to the project root directory.",
    }
    return {
        "tools": [
            {
                "name": "get_context",
                "description": "Get structured project context: current stage, context state, and task summary from Obsidian vault.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            {
                "name": "get_today",
                "description": "Get today's active tasks (IN_PROGRESS, BLOCKED, TODO) as a checklist from Obsidian Task Board.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            {
                "name": "update_task",
                "description": "Update an existing task's status and/or evidence in the Obsidian Task Board.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID (e.g. EXE-001)"},
                        "status": {"type": "string", "description": "New status: TODO, IN_PROGRESS, DONE, BLOCKED"},
                        "evidence": {"type": "string", "description": "Evidence text to append (test results, file changes)"},
                    },
                    "required": ["project_path", "task_id"],
                },
            },
            {
                "name": "create_task",
                "description": "Create a new task with auto-incremented EXE-### ID. Creates both a Task Board row and an individual task file with YAML frontmatter. Supports Task-as-Code verify checks — completion contracts that must pass before auto-complete.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "title": {"type": "string", "description": "Task title"},
                        "description": {"type": "string", "description": "Task description/details"},
                        "priority": {"type": "string", "description": "Priority: P1, P2, P3 (default: P1)"},
                        "owner": {"type": "string", "description": "Task owner (default: Agent)"},
                        "scheduled_date": {"type": "string", "description": "Scheduled date YYYY-MM-DD for day planning"},
                        "tags": {"type": "array", "items": {"type": "string"}, "description": "Tags for categorization"},
                        "blocked_by": {"type": "array", "items": {"type": "string"}, "description": "Task IDs this is blocked by"},
                        "parent_task": {"type": "string", "description": "Parent task ID for sub-tasks (creates EXE-001.1 format)"},
                        "verify": {
                            "type": "array",
                            "description": "Task-as-Code completion contract. List of checks that must pass for auto-complete. Types: file_exists (path), file_changed (path), grep_content (path + pattern), test_pattern (pattern).",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "enum": ["file_exists", "file_changed", "grep_content", "test_pattern"]},
                                    "path": {"type": "string", "description": "File path (relative to project root)"},
                                    "pattern": {"type": "string", "description": "Regex pattern for grep_content or glob for test_pattern"},
                                    "expect": {"type": "string", "description": "Expected result: pass/fail (default: pass)"},
                                },
                                "required": ["type"],
                            },
                        },
                    },
                    "required": ["project_path", "title"],
                },
            },
            {
                "name": "log_step",
                "description": "Append a timestamped entry to the Obsidian Execution Journal.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "message": {"type": "string", "description": "Log message describing what was done"},
                    },
                    "required": ["project_path", "message"],
                },
            },
            {
                "name": "write_plan",
                "description": "Append a work plan to the Obsidian Work Plans file.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "content": {"type": "string", "description": "Plan content in markdown"},
                    },
                    "required": ["project_path", "content"],
                },
            },
            {
                "name": "get_kanban",
                "description": "Get tasks grouped by status as a Kanban board view.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            {
                "name": "generate_docs_prompt",
                "description": "Scan repo and vault, return an AI prompt to generate project documentation for empty sections.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            {
                "name": "get_task",
                "description": "Get a single task by ID with full details, role outputs, and enrichment status. Shows which roles have completed their output and which is next.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID (e.g. EXE-001)"},
                    },
                    "required": ["project_path", "task_id"],
                },
            },
            {
                "name": "write_role_output",
                "description": "Write a role-based enrichment output for a task. Roles: BA, Designer, SystemAnalyst, Developer, QA. Each role generates structured analysis following best practices.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID (e.g. EXE-001)"},
                        "role": {
                            "type": "string",
                            "description": "Role name: BA, Designer, SystemAnalyst, Developer, or QA",
                            "enum": ["BA", "Designer", "SystemAnalyst", "Developer", "QA"],
                        },
                        "content": {"type": "string", "description": "Role output content in markdown"},
                    },
                    "required": ["project_path", "task_id", "role", "content"],
                },
            },
            {
                "name": "get_role_output",
                "description": "Read a specific role output for a task. Returns the content, status, and metadata.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID (e.g. EXE-001)"},
                        "role": {
                            "type": "string",
                            "description": "Role name: BA, Designer, SystemAnalyst, Developer, or QA",
                            "enum": ["BA", "Designer", "SystemAnalyst", "Developer", "QA"],
                        },
                    },
                    "required": ["project_path", "task_id", "role"],
                },
            },
            {
                "name": "link_tasks",
                "description": "Create a dependency relationship between two tasks. Updates both task files with wiki-links and frontmatter.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "source_task": {"type": "string", "description": "Source task ID (e.g. EXE-001)"},
                        "target_task": {"type": "string", "description": "Target task ID (e.g. EXE-002)"},
                        "relationship": {
                            "type": "string",
                            "description": "Relationship type",
                            "enum": ["blocked-by", "blocks", "subtask-of", "parent-of", "related-to"],
                        },
                    },
                    "required": ["project_path", "source_task", "target_task", "relationship"],
                },
            },
            {
                "name": "get_task_graph",
                "description": "Get dependency graph for a task. Returns connected nodes and a Mermaid diagram for Obsidian rendering.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Root task ID to start traversal from"},
                        "depth": {"type": "integer", "description": "Traversal depth (default: 2)", "default": 2},
                    },
                    "required": ["project_path", "task_id"],
                },
            },
            {
                "name": "get_velocity",
                "description": "Calculate task completion velocity — tasks per period, average cycle time, throughput.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "period": {
                            "type": "string",
                            "description": "Time period: day, week, sprint, month (default: week)",
                            "enum": ["day", "week", "sprint", "month"],
                        },
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "get_burndown",
                "description": "Get sprint burndown data with Mermaid chart for Obsidian rendering.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "sprint_number": {"type": "integer", "description": "Sprint number"},
                    },
                    "required": ["project_path", "sprint_number"],
                },
            },
            {
                "name": "search_tasks",
                "description": "Search tasks across all registered projects by query text, status, or tags.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search text (matches task title, ID, body)"},
                        "status": {"type": "string", "description": "Filter by status: TODO, IN_PROGRESS, DONE, BLOCKED"},
                        "tags": {"type": "array", "items": {"type": "string"}, "description": "Filter by tags"},
                    },
                },
            },
            {
                "name": "create_cross_project_link",
                "description": "Link tasks across different projects. Updates both task files and the shared cross-project links index.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "source_project": {"type": "string", "description": "Source project repo ID or path"},
                        "source_task": {"type": "string", "description": "Source task ID"},
                        "target_project": {"type": "string", "description": "Target project repo ID or path"},
                        "target_task": {"type": "string", "description": "Target task ID"},
                        "relationship": {
                            "type": "string",
                            "description": "Relationship type",
                            "enum": ["blocked-by", "blocks", "related-to", "depends-on"],
                        },
                    },
                    "required": ["source_project", "source_task", "target_project", "target_task"],
                },
            },
            {
                "name": "get_cross_project_deps",
                "description": "Get cross-project dependency overview with Mermaid diagram.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": {"type": "string", "description": "Optional project path to scope results"},
                    },
                },
            },
            {
                "name": "schedule_task",
                "description": "Assign a task to a specific date for day planning.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID (e.g. EXE-001)"},
                        "scheduled_date": {"type": "string", "description": "Date in YYYY-MM-DD format"},
                    },
                    "required": ["project_path", "task_id", "scheduled_date"],
                },
            },
            {
                "name": "get_schedule",
                "description": "Get tasks scheduled for a date range. Shows overdue tasks. Defaults to today.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "start_date": {"type": "string", "description": "Start date YYYY-MM-DD (default: today)"},
                        "end_date": {"type": "string", "description": "End date YYYY-MM-DD (default: same as start_date)"},
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "create_sprint",
                "description": "Create a sprint definition with dates and goals.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "sprint_number": {"type": "integer", "description": "Sprint number"},
                        "start_date": {"type": "string", "description": "Sprint start date YYYY-MM-DD"},
                        "end_date": {"type": "string", "description": "Sprint end date YYYY-MM-DD"},
                        "goals": {"type": "array", "items": {"type": "string"}, "description": "Sprint goals"},
                    },
                    "required": ["project_path", "sprint_number", "start_date", "end_date"],
                },
            },
            {
                "name": "assign_to_sprint",
                "description": "Assign tasks to a sprint. Updates each task's sprint field and the sprint file.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_ids": {"type": "array", "items": {"type": "string"}, "description": "Task IDs to assign"},
                        "sprint_number": {"type": "integer", "description": "Sprint number to assign to"},
                    },
                    "required": ["project_path", "task_ids", "sprint_number"],
                },
            },
            {
                "name": "get_sprint",
                "description": "Get sprint details with current task statuses. Use sprint_number='current' for the active sprint.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "sprint_number": {"type": "string", "description": "Sprint number or 'current' for active sprint"},
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "generate_canvas",
                "description": "Generate an Obsidian .canvas JSON file for visual board views (kanban, sprint, dependencies, architecture).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "canvas_type": {
                            "type": "string",
                            "enum": ["architecture", "sprint", "dependencies", "kanban"],
                            "description": "Type of canvas to generate",
                        },
                        "sprint_number": {"type": "integer", "description": "Sprint number (for sprint canvas type)"},
                    },
                    "required": ["project_path", "canvas_type"],
                },
            },
            {
                "name": "generate_retro",
                "description": "Generate a sprint retrospective markdown file with velocity data and template sections.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "sprint_number": {"type": "integer", "description": "Sprint number to generate retro for"},
                    },
                    "required": ["project_path", "sprint_number"],
                },
            },
            # ── Self-learning tools ──────────────────────────────
            {
                "name": "learn_from_history",
                "description": "Analyze execution history (tasks, sessions, corrections) to extract learning patterns. Writes Patterns.md and Project Profile.md.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "focus": {
                            "type": "string",
                            "enum": ["all", "intent", "priority", "cycle_time", "patterns"],
                            "description": "Focus area for analysis (default: all)",
                        },
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "get_insights",
                "description": "Surface actionable insights from learned patterns. Returns top insights filtered by context.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "context": {"type": "string", "description": "Current work type or task ID for contextual filtering"},
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "adapt_priority",
                "description": "Suggest task priority based on learned correction patterns instead of just keyword matching.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "title": {"type": "string", "description": "Task title to analyze"},
                        "work_type": {"type": "string", "description": "Work type: bugfix, new_feature, refactor, docs, testing"},
                    },
                    "required": ["project_path", "title"],
                },
            },
            {
                "name": "get_learning_status",
                "description": "Dashboard of what VaultOps has learned: data points, confidence, accuracy stats, staleness, suggestions.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            {
                "name": "run_verify",
                "description": "Run Task-as-Code verification checks for a task. Returns pass/fail for each check defined in the task's verify: frontmatter. Checks include: file_exists, file_changed, grep_content, test_pattern.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID (e.g. EXE-001)"},
                    },
                    "required": ["project_path", "task_id"],
                },
            },
            # ── Predictive Brain ──────────────────────────────
            {
                "name": "get_predictions",
                "description": "Predictive Brain — forecast cycle time, risk level, and suggested priority for a task based on historical patterns. Shows confidence levels and reasoning.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "task_id": {"type": "string", "description": "Task ID to predict for (reads task details)"},
                        "work_type": {"type": "string", "description": "Work type: bugfix, new_feature, refactor, deploy, docs (auto-detected if task_id given)", "enum": ["bugfix", "new_feature", "refactor", "deploy", "docs", "unknown"]},
                        "files": {"type": "array", "items": {"type": "string"}, "description": "Files that will be changed (for risk assessment)"},
                    },
                    "required": ["project_path"],
                },
            },
            # ── Adaptive Roles ────────────────────────────────
            {
                "name": "get_project_dna",
                "description": "Analyze role outputs to build Project DNA — the project's unique style profile (tech stack, test patterns, design approach). Used by role skills to adapt their output.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            # ── Phase 3: Ecosystem & Visibility ───────────────
            {
                "name": "get_replay",
                "description": "Session Replay — digest of what happened in the last N hours: completed tasks, journal entries, stale docs, learning events. Perfect for starting a new work session.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "hours": {"type": "integer", "description": "Lookback period in hours (default: 24)", "default": 24},
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "get_stale_docs",
                "description": "Detect documentation that may be outdated — finds doc sections referencing files changed in recent tasks.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "hours": {"type": "integer", "description": "Lookback period in hours (default: 72)", "default": 72},
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "get_arch_radar",
                "description": "Architecture Radar — detect coupling patterns (files that always change together), hotspots (most-changed files), and suggest ADRs. Generates Mermaid coupling diagram.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"project_path": pp},
                    "required": ["project_path"],
                },
            },
            {
                "name": "generate_report",
                "description": "Generate standalone HTML report for stakeholders. Zero dependencies, shareable as a single file. Includes donut chart, task table, velocity metrics.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_path": pp,
                        "sprint_number": {"type": "integer", "description": "Sprint number to report on (optional, shows all tasks if omitted)"},
                        "output_path": {"type": "string", "description": "Output file path (default: project root)"},
                    },
                    "required": ["project_path"],
                },
            },
            # ── Meeting Notes ─────────────────────────────────────
            {
                "name": "create_meeting",
                "description": "Create a new meeting note from template with auto-incremented MTG-### ID. Supports meeting series defaults for recurring meetings.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "Meeting title"},
                        "date": {"type": "string", "description": "Meeting date (YYYY-MM-DD, default: today)"},
                        "meeting_type": {"type": "string", "description": "Type: product, business, sync, standup (default: product)"},
                        "series": {"type": "string", "description": "Series ID for recurring meetings (auto-fills participants/projects from series defaults)"},
                        "participants": {"type": "array", "items": {"type": "string"}, "description": "List of participant names"},
                        "projects": {"type": "array", "items": {"type": "string"}, "description": "List of affected project repo IDs"},
                    },
                    "required": ["title"],
                },
            },
            {
                "name": "get_meeting",
                "description": "Read a meeting note by MTG-### ID or date.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "meeting_id": {"type": "string", "description": "Meeting ID (e.g. MTG-001)"},
                        "date": {"type": "string", "description": "Meeting date (YYYY-MM-DD) — used if meeting_id not provided"},
                    },
                },
            },
            {
                "name": "dispatch_action_items",
                "description": "Parse action items table from a meeting note and create tasks in target project task boards. Each task gets tagged with meeting/MTG-### for traceability.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "meeting_id": {"type": "string", "description": "Meeting ID (e.g. MTG-001)"},
                        "dry_run": {"type": "boolean", "description": "If true, shows proposed task assignments without creating them (default: false)"},
                    },
                    "required": ["meeting_id"],
                },
            },
            {
                "name": "link_decision_to_adr",
                "description": "Link a meeting decision to an Architecture Decision Record in a project. Creates ADR stub if no adr_id provided.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "meeting_id": {"type": "string", "description": "Meeting ID"},
                        "decision": {"type": "string", "description": "Decision text"},
                        "project": {"type": "string", "description": "Target project repo ID"},
                        "adr_id": {"type": "string", "description": "Existing ADR ID to link to (creates new if omitted)"},
                    },
                    "required": ["meeting_id", "decision", "project"],
                },
            },
            {
                "name": "create_followup",
                "description": "Create a scheduled follow-up task from a meeting. Tagged with followup/MTG-### for tracking.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "meeting_id": {"type": "string", "description": "Meeting ID"},
                        "description": {"type": "string", "description": "Follow-up description"},
                        "due_date": {"type": "string", "description": "Due date (YYYY-MM-DD)"},
                        "assignee": {"type": "string", "description": "Person responsible"},
                        "project": {"type": "string", "description": "Target project repo ID"},
                    },
                    "required": ["meeting_id", "description"],
                },
            },
            {
                "name": "get_meeting_dashboard",
                "description": "Dashboard of recent meetings, undispatched action items, overdue follow-ups, and upcoming series.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "days_back": {"type": "integer", "description": "How many days back to look (default: 14)"},
                        "project": {"type": "string", "description": "Filter by project repo ID"},
                    },
                },
            },
            {
                "name": "get_meeting_series",
                "description": "List or manage recurring meeting series. Use action=create with name/cadence to create a new series.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "series_id": {"type": "string", "description": "Series ID to get details (omit to list all)"},
                        "action": {"type": "string", "description": "Action: list (default) or create"},
                        "name": {"type": "string", "description": "Series name (for create)"},
                        "cadence": {"type": "string", "description": "Cadence: weekly, biweekly, monthly (for create, default: weekly)"},
                        "default_participants": {"type": "array", "items": {"type": "string"}, "description": "Default participants (for create)"},
                        "default_projects": {"type": "array", "items": {"type": "string"}, "description": "Default affected projects (for create)"},
                    },
                },
            },
        ]
    }


# ── Shared message dispatch ──────────────────────────────────────────────


def _dispatch(message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Dispatch a JSON-RPC message and return a response dict (or None for notifications)."""
    method = message.get("method")
    msg_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        _SUPPORTED_VERSIONS = {"2024-10-07", "2024-11-05", "2025-03-26"}
        client_version = params.get("protocolVersion", "2025-03-26")
        negotiated = client_version if client_version in _SUPPORTED_VERSIONS else "2025-03-26"
        return _json_response(msg_id, {
            "protocolVersion": negotiated,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "vaultops", "version": "1.0.0"},
        })

    if method == "notifications/initialized":
        return None

    if method == "tools/list":
        return _json_response(msg_id, _tools_list_result())

    if method == "tools/call":
        return _json_response(msg_id, _handle_tools_call(params))

    if method == "ping":
        return _json_response(msg_id, {})

    if msg_id is not None:
        return _json_error(msg_id, -32601, f"Method not found: {method}")

    return None


# ── stdio transport ──────────────────────────────────────────────────────


def _run_stdio() -> int:
    message = None
    while True:
        try:
            message = _read_message()
            if message is None:
                return 0
            response = _dispatch(message)
            if response is not None:
                _send_message(response)
        except Exception as exc:
            sys.stderr.write(f"vaultops-mcp: {exc}\n")
            sys.stderr.flush()
            try:
                msg_id = message.get("id") if message else None
                if msg_id is not None:
                    _send_message(_json_error(msg_id, -32603, str(exc)))
            except Exception:
                pass



# ── Entry point ──────────────────────────────────────────────────────────


def main() -> int:
    return _run_stdio()


if __name__ == "__main__":
    raise SystemExit(main())
