#!/usr/bin/env python3
"""VaultOps Brain — PreToolUse hook.

Fires before Edit/Write/Bash tools. Injects task context, tracks files
in session state, and detects architecture-relevant changes that need
doc updates.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

_hooks_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _hooks_dir)
sys.path.insert(0, os.path.dirname(_hooks_dir))

from brain_state import (  # noqa: E402
    is_vaultops_project,
    load_state,
    save_state,
    is_architecture_file,
    predict_risk,
    get_file_history,
)
from vaultops_mcp_server import _tool_get_context, _resolve_vault_project  # noqa: E402

resolve_vault_project = _resolve_vault_project


def main() -> None:
    project_path = os.getcwd()

    if not is_vaultops_project(project_path):
        return

    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        hook_input = {}

    tool_name = hook_input.get("tool_name", "")
    tool_input = hook_input.get("tool_input", {})

    state = load_state(project_path)

    # If suppressed, skip all tracking
    if state.get("suppressed"):
        return

    now = datetime.now(timezone.utc).isoformat()

    # Track what's about to happen
    if tool_name in ("Edit", "Write"):
        file_path = tool_input.get("file_path", "")
        if file_path:
            entry = {"path": file_path, "timestamp": now}
            if tool_name == "Edit":
                if file_path not in [e["path"] for e in state["files_edited"]]:
                    state["files_edited"].append(entry)
            else:
                if file_path not in [e["path"] for e in state["files_created"]]:
                    state["files_created"].append(entry)

            # Architecture detection
            if is_architecture_file(file_path) and file_path not in state["docs_touched"]:
                state["docs_touched"].append(file_path)

    elif tool_name == "Bash":
        command = tool_input.get("command", "")
        if command:
            summary = command[:100]
            state["bash_commands_summary"].append({"summary": summary, "timestamp": now})

    # Update phase if we were idle and now tracking files
    if state["phase"] == "idle" and (state["files_edited"] or state["files_created"]):
        state["phase"] = "working"

    save_state(project_path, state)

    # Build context output
    lines = []

    # Inject current task context
    try:
        result = _tool_get_context({"project_path": project_path})
        content = result.get("content", [{}])
        if content and isinstance(content, list):
            text = content[0].get("text", "")
            data = json.loads(text) if text else {}
        else:
            data = {}

        active = data.get("active_tasks", [])
        blocked = data.get("blocked_tasks", [])
        summary = data.get("task_summary", {})

        if active:
            focus = active[0]
            lines.append(f"[VaultOps] Active: {focus['id']} \u2014 {focus['task']} [{focus.get('priority', '')}]")
        if summary.get("in_progress", 0) > 1:
            lines.append(f"({summary['in_progress']} tasks in progress)")
        if blocked:
            lines.append(f"\u26a0\ufe0f {len(blocked)} blocked task(s)")
    except Exception:
        pass

    # ── Predictive Brain: risk detection on file accumulation ────────
    edited_paths = [e["path"] if isinstance(e, dict) else e for e in state.get("files_edited", [])]
    created_paths = [e["path"] if isinstance(e, dict) else e for e in state.get("files_created", [])]
    all_paths = edited_paths + created_paths
    # Show risk warning once when crossing 4-file threshold
    if len(all_paths) == 4 and state.get("active_task_id") and not state.get("risk_warned"):
        try:
            risk = predict_risk(project_path, all_paths)
            if risk.get("risk_level") in ("medium", "high"):
                risk_level = risk["risk_level"].upper()
                lines.append(f"[Predictive Brain] Risk: {risk_level}")
                for reason in risk.get("reasons", [])[:3]:
                    lines.append(f"  \u00b7 {reason}")
                rec = risk.get("recommendation")
                if rec:
                    lines.append(f"  \u2192 {rec}")
                # Verify suggestion for high risk
                if risk.get("risk_level") == "high" and state.get("active_task_id"):
                    lines.append(f"  \u2192 Consider: /vault:task {state['active_task_id']} verify")
                state["risk_warned"] = True
        except Exception:
            pass

    # ── Arch Radar: hotspot detection per file ────────────────────────
    if tool_name in ("Edit", "Write"):
        file_path = tool_input.get("file_path", "")
        if file_path and file_path not in state.get("hotspot_warned", []):
            try:
                history = get_file_history(project_path, file_path)
                if history["count"] >= 3:
                    basename = os.path.basename(file_path)
                    reopen_note = f", {history['reopened']} reopened" if history["reopened"] else ""
                    lines.append(
                        f"[Arch Radar] Hotspot: {basename} changed in {history['count']} tasks{reopen_note}"
                    )
                    warned = state.get("hotspot_warned", [])
                    warned.append(file_path)
                    state["hotspot_warned"] = warned
            except Exception:
                pass

    # Auto-inject doc update instruction for architecture files
    if tool_name in ("Edit", "Write"):
        file_path = tool_input.get("file_path", "")
        if file_path and is_architecture_file(file_path):
            filename = os.path.basename(file_path)
            lines.append(f"[VaultOps] Architecture file changed: {filename}")
            lines.append(
                "You MUST update the relevant Obsidian documentation now using "
                "mcp__vaultops__* tools (log_step, write_plan, or generate_docs_prompt). "
                "Update architecture notes in the vault to reflect this change."
            )

    # ── Meeting awareness: undispatched action items ─────────────────
    if not state.get("meeting_warned"):
        try:
            vault_project = resolve_vault_project(project_path)
            if vault_project:
                vault_root = os.path.dirname(vault_project)
                meetings_notes = os.path.join(vault_root, "_meetings", "Notes")
                if os.path.isdir(meetings_notes):
                    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                    undispatched = []
                    for fname in os.listdir(meetings_notes):
                        if not fname.endswith(".md"):
                            continue
                        fpath = os.path.join(meetings_notes, fname)
                        with open(fpath, "r") as f:
                            head = f.read(1024)
                        if "action_items_dispatched: false" in head:
                            # Extract date from filename or frontmatter
                            m = re.search(r"date:\s*(\d{4}-\d{2}-\d{2})", head)
                            if m and m.group(1) < today:
                                mid = re.search(r"meeting_id:\s*(MTG-\d+)", head)
                                mid_str = mid.group(1) if mid else fname
                                undispatched.append(mid_str)
                    if undispatched:
                        lines.append(
                            f"[Meeting] {len(undispatched)} meeting(s) have undispatched action items: "
                            f"{', '.join(undispatched[:3])}. Use /vault:meeting process <ID> to dispatch."
                        )
                        state["meeting_warned"] = True
        except Exception:
            pass

    if lines:
        print(json.dumps({"additionalContext": "\n".join(lines)}))


if __name__ == "__main__":
    main()
