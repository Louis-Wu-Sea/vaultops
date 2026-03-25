#!/usr/bin/env python3
"""VaultOps Brain — SessionStart hook.

Fires on session startup/resume/clear/compact.
Initializes session state and loads any active IN_PROGRESS task from the vault.
"""

import json
import os
import sys
from datetime import datetime, timezone

# Add hooks dir and parent for imports
_hooks_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _hooks_dir)
sys.path.insert(0, os.path.dirname(_hooks_dir))

from brain_state import is_vaultops_project, load_state, save_state, _DEFAULT_STATE  # noqa: E402
from vaultops_mcp_server import (  # noqa: E402
    _tool_get_context,
    _tool_get_replay,
    _exec_path,
    _read_file,
    _parse_frontmatter,
    EXEC_JOURNAL,
    SPRINTS_DIR,
)


def main() -> None:
    project_path = os.getcwd()

    if not is_vaultops_project(project_path):
        return

    # Initialize fresh state
    state = dict(_DEFAULT_STATE)
    state["session_start"] = datetime.now(timezone.utc).isoformat()

    # Load current vault context to find active tasks
    try:
        result = _tool_get_context({"project_path": project_path})
        content = result.get("content", [{}])
        if content and isinstance(content, list):
            text = content[0].get("text", "")
            data = json.loads(text) if text else {}
        else:
            data = {}
    except Exception:
        data = {}

    active_tasks = data.get("active_tasks", [])
    task_summary = data.get("task_summary", {})

    # If there's an active task, resume it
    lines = ["[VaultOps Brain \u2014 Active]"]

    if active_tasks:
        focus = active_tasks[0]
        state["active_task_id"] = focus["id"]
        state["phase"] = "working"
        lines.append(f"Resuming {focus['id']}: {focus['task']} [{focus.get('priority', '')}]")
        if len(active_tasks) > 1:
            lines.append(f"({len(active_tasks)} tasks in progress)")
    else:
        lines.append("No active task \u2014 will auto-create on first work intent.")

    blocked = data.get("blocked_tasks", [])
    if blocked:
        lines.append(f"\u26a0\ufe0f {len(blocked)} blocked task(s)")

    total = task_summary.get("total", 0)
    done = task_summary.get("done", 0)
    if total:
        lines.append(f"Vault: {done}/{total} tasks done")

    # Surface learning insight if available
    try:
        from vaultops_mcp_server import _resolve_vault_project, _parse_frontmatter, _read_file as _rf
        vault_project = _resolve_vault_project(project_path)
        if vault_project:
            patterns_path = os.path.join(vault_project, "08-Execution", "Learnings", "Patterns.md")
            if os.path.isfile(patterns_path):
                pfm, _ = _parse_frontmatter(_rf(patterns_path))
                conf = pfm.get("confidence", "low")
                analyzed = pfm.get("total_tasks_analyzed", 0)
                if conf in ("medium", "high") and analyzed:
                    lines.append(f"Learning: {conf} confidence ({analyzed} tasks analyzed)")
    except Exception:
        pass

    # ── Auto-Replay: compact digest of recent activity ──────────────
    try:
        replay = _tool_get_replay({"project_path": project_path, "hours": 24})
        replay_content = replay.get("content", [{}])
        if replay_content and isinstance(replay_content, list):
            replay_text = replay_content[0].get("text", "")
            # Extract JSON from receipt (after the visual part)
            for segment in replay_text.split("\n\n"):
                s = segment.strip()
                if s.startswith("{"):
                    try:
                        rd = json.loads(s)
                        parts = []
                        if rd.get("tasks_completed"):
                            parts.append(f"{rd['tasks_completed']} task(s) completed")
                        if rd.get("tasks_created"):
                            parts.append(f"{rd['tasks_created']} created")
                        if rd.get("stale_docs"):
                            parts.append(f"{rd['stale_docs']} stale doc(s)")
                        if parts:
                            lines.append(f"Last 24h: {', '.join(parts)}")
                        break
                    except (json.JSONDecodeError, TypeError):
                        continue
    except Exception:
        pass

    # ── Sprint deadline check ─────────────────────────────────────
    try:
        exec_dir, err = _exec_path(project_path)
        if not err:
            sprints_path = os.path.join(exec_dir, SPRINTS_DIR)
            if os.path.isdir(sprints_path):
                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                for fname in os.listdir(sprints_path):
                    if fname.startswith("Sprint-") and fname.endswith(".md") and "Retro" not in fname:
                        sc = _read_file(os.path.join(sprints_path, fname))
                        sfm, _ = _parse_frontmatter(sc)
                        end_date = sfm.get("end_date", "")
                        sprint_num = sfm.get("number", fname.replace("Sprint-", "").replace(".md", ""))
                        if end_date and end_date <= today:
                            # Check if retro exists
                            retro_file = os.path.join(sprints_path, f"Sprint-{sprint_num}-Retro.md")
                            if not os.path.isfile(retro_file):
                                lines.append(f"\U0001f4e2 Sprint {sprint_num} ended ({end_date}) — run /vault:retro {sprint_num}")
    except Exception:
        pass

    lines.append('Auto-tracking: tasks, journal, docs. Say "don\'t track" to suppress.')

    save_state(project_path, state)

    print(json.dumps({"additionalContext": "\n".join(lines)}))


if __name__ == "__main__":
    main()
