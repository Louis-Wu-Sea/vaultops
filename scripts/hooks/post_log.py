#!/usr/bin/env python3
"""VaultOps Brain — PostToolUse hook.

Fires after Edit/Write/Bash tools. Logs execution steps, collects
evidence from test runs and git commits, and auto-updates task evidence.
"""

import json
import os
import sys

_hooks_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _hooks_dir)
sys.path.insert(0, os.path.dirname(_hooks_dir))

from brain_state import (  # noqa: E402
    is_vaultops_project,
    load_state,
    save_state,
    is_test_command,
    is_commit_command,
    extract_test_results,
    extract_commit_sha,
    extract_commit_message,
)
from vaultops_mcp_server import (  # noqa: E402
    _tool_log_step,
    _tool_update_task,
    _tool_get_project_dna,
    ROLE_OUTPUTS_DIR,
)


def main() -> None:
    project_path = os.getcwd()

    if not is_vaultops_project(project_path):
        return

    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        return

    tool_name = hook_input.get("tool_name", "")
    tool_input = hook_input.get("tool_input", {})
    tool_result = hook_input.get("tool_result", "")

    state = load_state(project_path)

    # If suppressed, skip
    if state.get("suppressed"):
        return

    # Build log message based on tool type
    message = ""
    evidence_update = ""

    if tool_name == "Edit":
        file_path = tool_input.get("file_path", "unknown")
        filename = os.path.basename(file_path)
        message = f"Edited {filename}"

    elif tool_name == "Write":
        file_path = tool_input.get("file_path", "unknown")
        filename = os.path.basename(file_path)
        message = f"Created/wrote {filename}"

    elif tool_name == "Bash":
        command = tool_input.get("command", "")
        output = str(tool_result)[:3000] if tool_result else ""

        # Test evidence collection
        if is_test_command(command):
            state["tests_run"] = True
            is_test, passed, summary = extract_test_results(output)
            if is_test:
                state["tests_passed"] = passed
                message = f"Ran tests: {summary}"
                evidence_update = summary

        # Commit evidence collection
        elif is_commit_command(command):
            sha = extract_commit_sha(output)
            if sha:
                commit_msg = extract_commit_message(output)
                state["commits"].append({"sha": sha, "message": commit_msg})
                message = f"Committed {sha}"
                if commit_msg:
                    message += f": {commit_msg[:50]}"
                evidence_update = f"Commit {sha}"
                if commit_msg:
                    evidence_update += f": {commit_msg[:40]}"

        else:
            # Generic bash — short summary
            cmd_short = command.split("\n")[0][:60]
            message = f"Ran: {cmd_short}"

    # Log to Execution Journal
    if message:
        try:
            _tool_log_step({"project_path": project_path, "message": message})
        except Exception:
            pass

    # Auto-update task evidence
    if evidence_update and state.get("active_task_id"):
        try:
            _tool_update_task({
                "project_path": project_path,
                "task_id": state["active_task_id"],
                "evidence": evidence_update,
            })
        except Exception:
            pass

    # ── Auto: Test failure warning ────────────────────────────────────
    output_lines = []
    if state.get("tests_passed") is False and state.get("active_task_id"):
        output_lines.append(
            f"[VaultOps] Tests failed. {state['active_task_id']} will NOT auto-complete until tests pass."
        )

    # ── Auto: Enrichment counter → DNA rebuild ────────────────────────
    if tool_name == "Write":
        file_path = tool_input.get("file_path", "")
        if ROLE_OUTPUTS_DIR in file_path and file_path.endswith(".md"):
            count = state.get("enrichment_count", 0) + 1
            state["enrichment_count"] = count
            # Rebuild DNA every 5 enrichments
            if count % 5 == 0:
                try:
                    _tool_get_project_dna({"project_path": project_path})
                    output_lines.append(
                        f"[VaultOps] Project DNA auto-updated ({count} enrichments analyzed)."
                    )
                except Exception:
                    pass

    save_state(project_path, state)

    if output_lines:
        print(json.dumps({"additionalContext": "\n".join(output_lines)}))


if __name__ == "__main__":
    main()
