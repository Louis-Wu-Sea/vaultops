#!/usr/bin/env python3
"""VaultOps Brain — Stop hook (session end).

Auto-completes tasks when evidence supports it (tests passed + commit),
generates a rich impact receipt with task lifecycle, and flags
architecture docs that need updating.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import List

_hooks_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _hooks_dir)
sys.path.insert(0, os.path.dirname(_hooks_dir))

from brain_state import (  # noqa: E402
    is_vaultops_project,
    load_state,
    cleanup_state,
    log_learning_event,
)
from vaultops_mcp_server import (  # noqa: E402
    _exec_path,
    _read_file,
    _atomic_write,
    _vault_stats,
    _progress_bar,
    _tool_update_task,
    _tool_log_step,
    _parse_frontmatter,
    _parse_verify_checks,
    _run_verify_checks,
    _detect_stale_docs,
    _resolve_vault_project,
    _RECEIPT_SEP,
    EXEC_JOURNAL,
    TASKS_DIR,
    SPRINTS_DIR,
)


_BRAIN_SEP = "\u2501" * 43


def _today_entries(journal_path: str, today: str) -> List[str]:
    """Extract meaningful journal entries from today."""
    content = _read_file(journal_path)
    entries: List[str] = []
    for line in content.split("\n"):
        if not line.startswith(f"## {today}"):
            continue
        entry = re.sub(rf"^## {re.escape(today)}\s*[\u2014\-]\s*", "", line).strip()
        if entry and "Session ended" not in entry:
            entries.append(entry)
    return entries


def main() -> None:
    project_path = os.getcwd()

    if not is_vaultops_project(project_path):
        return

    exec_dir, err = _exec_path(project_path)
    if err:
        return

    state = load_state(project_path)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now_iso = datetime.now(timezone.utc).isoformat()

    # ── Auto-completion logic ─────────────────────────────────────────────
    task_lifecycle = None
    auto_completed = False

    if state.get("active_task_id") and not state.get("suppressed"):
        task_id = state["active_task_id"]
        tests_passed = state.get("tests_passed")
        commits = state.get("commits", [])
        tests_run = state.get("tests_run", False)
        files_edited = state.get("files_edited", [])
        files_created = state.get("files_created", [])

        # Build evidence summary
        evidence_parts = []
        file_count = len(files_edited) + len(files_created)
        if file_count:
            evidence_parts.append(f"{file_count} file{'s' if file_count != 1 else ''}")
        if tests_run:
            if tests_passed:
                evidence_parts.append("tests \u2713")
            elif tests_passed is False:
                evidence_parts.append("tests \u2717")
        if commits:
            sha_list = ", ".join(c["sha"][:7] for c in commits[:3])
            evidence_parts.append(f"commit{'s' if len(commits) > 1 else ''} {sha_list}")

        evidence_str = ", ".join(evidence_parts) if evidence_parts else "no evidence"

        # Auto-complete: both tests passed AND commit required
        # Fallback: if tests were never run (no test suite), commit alone suffices
        can_complete = False
        if tests_passed and commits:
            can_complete = True
        elif not tests_run and commits:
            # No test suite in project — commit alone is enough
            can_complete = True

        # ── Task-as-Code: verify checks gate ──────────────────────────
        verify_result = None
        if can_complete:
            try:
                task_file = os.path.join(exec_dir, TASKS_DIR, f"{task_id}.md")
                if os.path.isfile(task_file):
                    task_content = _read_file(task_file)
                    fm, _ = _parse_frontmatter(task_content)
                    checks = _parse_verify_checks(fm)
                    if checks:
                        verify_result = _run_verify_checks(
                            checks, project_path, files_edited=files_edited + files_created
                        )
                        if not verify_result["all_passed"]:
                            can_complete = False  # Block auto-complete
            except Exception:
                pass  # Don't block on verify errors

        if can_complete:
            try:
                verify_note = ""
                if verify_result:
                    verify_note = f", verify {verify_result['passed']}/{verify_result['total']} ✓"
                _tool_update_task({
                    "project_path": project_path,
                    "task_id": task_id,
                    "status": "DONE",
                    "evidence": evidence_str + verify_note,
                })
                auto_completed = True
            except Exception:
                pass

        # Build lifecycle line
        created_label = "Auto-created" if state.get("task_auto_created") else "Resumed"
        if auto_completed:
            status_flow = f"{created_label} \u2192 IN_PROGRESS \u2192 DONE"
        elif verify_result and not verify_result["all_passed"]:
            failed = verify_result["total"] - verify_result["passed"]
            status_flow = f"{created_label} \u2192 IN_PROGRESS (verify: {failed} check{'s' if failed != 1 else ''} failed)"
        elif tests_passed is False:
            status_flow = f"{created_label} \u2192 IN_PROGRESS (tests failing)"
        else:
            status_flow = f"{created_label} \u2192 IN_PROGRESS"

        task_lifecycle = {
            "id": task_id,
            "summary": state.get("user_prompt_summary", "")[:40],
            "status_flow": status_flow,
            "evidence": evidence_str,
            "verify_result": verify_result,
        }

    # ── Log task outcome for learning ────────────────────────────────────
    if state.get("active_task_id") and not state.get("suppressed"):
        cycle_hours = 0.0
        session_start = state.get("session_start", "")
        if session_start:
            try:
                start = datetime.fromisoformat(session_start.replace("Z", "+00:00"))
                cycle_hours = round((datetime.now(timezone.utc) - start).total_seconds() / 3600, 2)
            except (ValueError, TypeError):
                pass

        learning_data = {
            "task_id": state["active_task_id"],
            "auto_completed": auto_completed,
            "auto_created": state.get("task_auto_created", False),
            "cycle_time_hours": cycle_hours,
            "work_type": state.get("intent", "unknown"),
            "files_edited": len(state.get("files_edited", [])),
            "files_created": len(state.get("files_created", [])),
            "tests_run": state.get("tests_run", False),
            "tests_passed": state.get("tests_passed"),
            "commits": len(state.get("commits", [])),
            "prompt_count": state.get("prompt_count", 0),
            "match_layer": state.get("intent_match_layer"),
            "original_priority": state.get("original_priority"),
        }

        # Add verify result to learning data
        if verify_result is not None:
            learning_data["verify_passed"] = verify_result["passed"]
            learning_data["verify_total"] = verify_result["total"]
            learning_data["verify_all_passed"] = verify_result["all_passed"]
            if not verify_result["all_passed"]:
                failed_types = [r["type"] for r in verify_result["results"] if not r["passed"]]
                learning_data["verify_failed_types"] = ", ".join(failed_types)

        log_learning_event(project_path, "task_completed" if auto_completed else "session_ended", learning_data)

        # Log separate verification_result event for pattern analysis
        if verify_result is not None:
            log_learning_event(project_path, "verification_result", {
                "task_id": state["active_task_id"],
                "passed": verify_result["passed"],
                "total": verify_result["total"],
                "all_passed": verify_result["all_passed"],
                "blocked_completion": not verify_result["all_passed"] and bool(state.get("commits")),
            })

    # ── Collect vault stats ───────────────────────────────────────────────
    try:
        stats = _vault_stats(exec_dir)
    except Exception:
        stats = {"done": 0, "active": 0, "todo": 0, "blocked": 0, "total": 0, "docs": 0}

    journal_path = os.path.join(exec_dir, EXEC_JOURNAL)
    entries = _today_entries(journal_path, today)

    d = stats["done"]
    a = stats["active"]
    t = stats["todo"]
    total = stats["total"]
    docs = stats["docs"]
    bar = _progress_bar(d, total)

    # ── Build rich receipt ────────────────────────────────────────────────
    lines = [
        _BRAIN_SEP,
        "\u2b21  VaultOps Brain  \u00b7  Session Report",
        _BRAIN_SEP,
        "",
    ]

    # Task lifecycle section
    if task_lifecycle:
        lines.append("  TASK LIFECYCLE")
        tid = task_lifecycle["id"]
        summary = task_lifecycle["summary"]
        if summary:
            lines.append(f"  \u2726  {tid}: {summary}")
        else:
            lines.append(f"  \u2726  {tid}")
        lines.append(f"     {task_lifecycle['status_flow']}")
        lines.append(f"     Evidence: {task_lifecycle['evidence']}")

        # Show verify check details if any
        vr = task_lifecycle.get("verify_result")
        if vr and vr.get("results"):
            lines.append("")
            lines.append("  VERIFY CONTRACT")
            for r in vr["results"]:
                icon = "\u2713" if r["passed"] else "\u2717"
                lines.append(f"     {icon}  {r['detail']}")

        lines.append("")

    # Session activity
    if entries:
        lines.append(f"  SESSION ACTIVITY")
        lines.append(f"  \U0001f4d3  {len(entries)} step{'s' if len(entries) != 1 else ''} captured")
        for e in entries[:8]:
            label = e[:45] + ("\u2026" if len(e) > 45 else "")
            lines.append(f"     \u00b7 {label}")
        if len(entries) > 8:
            lines.append(f"     \u00b7 +{len(entries) - 8} more in journal")
        lines.append("")

    # Vault state
    lines.append(f"  {bar}  {d}\u2713  {a}\u25b6  {t}\u25cb  of {total}")
    lines.append(f"  \u25c8  {docs} docs across vault")
    lines.append("")

    # Learning status
    try:
        from vaultops_mcp_server import _resolve_vault_project, _parse_frontmatter
        vault_project = _resolve_vault_project(project_path)
        if vault_project:
            log_path = os.path.join(vault_project, "08-Execution", "Learnings", "Learning Log.md")
            profile_path = os.path.join(vault_project, "08-Execution", "Learnings", "Project Profile.md")
            if os.path.isfile(log_path):
                log_lines = _read_file(log_path).count("\n## ")
                profile_fm = {}
                if os.path.isfile(profile_path):
                    profile_fm, _ = _parse_frontmatter(_read_file(profile_path))
                conf = profile_fm.get("confidence", "low")
                acc = profile_fm.get("intent_accuracy")
                acc_str = f" · intent {int(float(acc)*100)}%" if acc and acc != "N/A" else ""
                lines.append(f"  \U0001f9e0  Learning: {log_lines} events · {conf} confidence{acc_str}")
                lines.append("")
    except Exception:
        pass

    # Docs flag
    docs_touched = state.get("docs_touched", [])
    if docs_touched:
        lines.append(f"  \u26a0  DOCS FLAG: {len(docs_touched)} architecture file{'s' if len(docs_touched) != 1 else ''} changed")
        for fp in docs_touched[:5]:
            lines.append(f"     \u00b7 {os.path.basename(fp)}")
        lines.append("     Run /vault:docs next session to update.")
        lines.append("")

    # ── Auto: Stale docs detection ────────────────────────────────────
    try:
        stale = _detect_stale_docs(exec_dir, project_path, 72)
        if stale:
            lines.append(f"  \U0001f4d6  STALE DOCS ({len(stale)} section{'s' if len(stale) != 1 else ''})")
            for s in stale[:3]:
                lines.append(f"     \u00b7 {s['section']}: {s['reason'][:40]}")
            lines.append("     Run /vault:docs to refresh.")
            lines.append("")
    except Exception:
        pass

    # ── Auto: Coupling hint (files from different modules) ────────────
    try:
        edited_paths = [e["path"] if isinstance(e, dict) else e for e in state.get("files_edited", [])]
        modules = set()
        for fp in edited_paths:
            parts = fp.split("/")
            if len(parts) >= 2:
                modules.add(parts[0] if parts[0] != "src" else (parts[1] if len(parts) >= 3 else parts[0]))
        if len(modules) >= 3:
            lines.append(f"  \U0001f4e1  COUPLING: {len(modules)} modules changed in one task")
            lines.append(f"     Modules: {', '.join(sorted(modules)[:5])}")
            lines.append("     Run /vault:radar to analyze coupling patterns.")
            lines.append("")
    except Exception:
        pass

    # ── Auto: Sprint deadline check ───────────────────────────────────
    try:
        sprints_path = os.path.join(exec_dir, SPRINTS_DIR)
        if os.path.isdir(sprints_path):
            for fname in os.listdir(sprints_path):
                if fname.startswith("Sprint-") and fname.endswith(".md") and "Retro" not in fname:
                    sc = _read_file(os.path.join(sprints_path, fname))
                    sfm, _ = _parse_frontmatter(sc)
                    end_date = sfm.get("end_date", "")
                    sprint_num = sfm.get("number", fname.replace("Sprint-", "").replace(".md", ""))
                    if end_date and end_date <= today:
                        retro_file = os.path.join(sprints_path, f"Sprint-{sprint_num}-Retro.md")
                        if not os.path.isfile(retro_file):
                            lines.append(f"  \U0001f4e2  Sprint {sprint_num} ended ({end_date}) \u2014 run /vault:retro {sprint_num}")
                            lines.append("")
                            break  # Only show one sprint reminder
    except Exception:
        pass

    lines.append(_BRAIN_SEP)

    report = "\n".join(lines)

    # ── Log session end to journal ────────────────────────────────────────
    task_note = ""
    if task_lifecycle:
        tid = task_lifecycle["id"]
        if auto_completed:
            task_note = f" \u00b7 {tid} \u2192 DONE"
        else:
            task_note = f" \u00b7 {tid} in progress"

    log_entry = (
        f"\n## {today} \u2014 Session ended"
        f" | {d}\u2713 {a}\u25b6 {t}\u25cb tasks \u00b7 {docs} docs{task_note}\n"
        f"- Logged: {now_iso}\n"
    )
    existing = _read_file(journal_path)
    _atomic_write(journal_path, existing + log_entry)

    # ── Cleanup ───────────────────────────────────────────────────────────
    cleanup_state(project_path)

    # ── Output ────────────────────────────────────────────────────────────
    print(json.dumps({"systemMessage": report}))


if __name__ == "__main__":
    main()
