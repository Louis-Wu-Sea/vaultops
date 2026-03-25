#!/usr/bin/env python3
"""VaultOps Brain — UserPromptSubmit hook.

Fires on every user prompt. Classifies intent and auto-creates tasks.
This is the core autonomy hook — it decides when to create tasks,
when to continue existing ones, and when to stay silent.
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
    classify_intent,
    log_learning_event,
    predict_cycle_time,
    predict_priority,
    predict_risk,
)
from vaultops_mcp_server import (  # noqa: E402
    _tool_create_task,
    _tool_update_task,
    _tool_log_step,
    _exec_path,
    _read_file,
    _parse_task_board,
    TASK_BOARD,
)


def main() -> None:
    project_path = os.getcwd()

    if not is_vaultops_project(project_path):
        return

    # Read hook input
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        return

    prompt = hook_input.get("prompt", "")
    if not prompt.strip():
        return

    state = load_state(project_path)
    state["prompt_count"] += 1

    # Already suppressed
    if state["suppressed"]:
        save_state(project_path, state)
        return

    # Load existing tasks for classification
    exec_dir, err = _exec_path(project_path)
    if err:
        save_state(project_path, state)
        return

    task_board_md = _read_file(os.path.join(exec_dir, TASK_BOARD))
    existing_tasks = _parse_task_board(task_board_md)

    # Detect user corrections from previous session state
    # (priority changed, task reopened since last prompt)
    if state.get("active_task_id") and state.get("original_priority"):
        for t in existing_tasks:
            if t["id"] == state["active_task_id"]:
                cur_priority = t.get("priority", "")
                if cur_priority and cur_priority != state["original_priority"]:
                    log_learning_event(project_path, "user_correction", {
                        "type": "priority_changed",
                        "task_id": t["id"],
                        "from": state["original_priority"],
                        "to": cur_priority,
                        "signal": "priority_miscalibrated",
                    })
                    state["original_priority"] = cur_priority
                cur_status = t.get("status", "")
                if cur_status == "IN_PROGRESS" and state.get("phase") == "idle":
                    # Task was reopened externally
                    log_learning_event(project_path, "user_correction", {
                        "type": "task_reopened",
                        "task_id": t["id"],
                        "signal": "premature_auto_completion",
                    })
                break

    # Classify intent
    result = classify_intent(prompt, existing_tasks, state.get("active_task_id"))
    action = result.get("action", "none")

    # Log classification event for learning
    import hashlib as _hl
    log_learning_event(project_path, "intent_classified", {
        "prompt_hash": _hl.md5(prompt.encode()).hexdigest()[:8],
        "classified_action": action,
        "classified_intent": result.get("intent"),
        "match_layer": result.get("match_layer"),
        "priority_assigned": result.get("priority"),
        "active_task": state.get("active_task_id"),
    })

    output_lines = []

    if action == "suppress":
        state["suppressed"] = True
        save_state(project_path, state)
        print(json.dumps({"additionalContext": "[VaultOps] Tracking suppressed for this session."}))
        return

    if action == "question":
        # No task needed, but save state
        state["intent"] = "question"
        save_state(project_path, state)
        return

    if action == "reuse":
        task_id = result.get("task_id", "")
        if task_id:
            state["active_task_id"] = task_id
            state["phase"] = "working"
            state["intent"] = result.get("intent", "new_feature")
            if not state["user_prompt_summary"]:
                state["user_prompt_summary"] = prompt[:200]
            save_state(project_path, state)
            output_lines.append(f"[VaultOps] Continuing {task_id}. Changes auto-logged.")
        else:
            save_state(project_path, state)
            return

    elif action == "continue":
        task_id = result.get("task_id", "")
        state["phase"] = "working"
        save_state(project_path, state)
        output_lines.append(f"[VaultOps] Continuing {task_id}. Changes auto-logged.")

    elif action == "create":
        title = result.get("title", "Untitled task")
        priority = result.get("priority", "P2")
        intent = result.get("intent", "new_feature")

        # ── Predictive Brain: calibrate priority ─────────────────────
        prediction_hint = ""
        try:
            priority_pred = predict_priority(project_path, intent)
            if priority_pred.get("confidence") in ("high", "medium"):
                suggested = priority_pred.get("suggested_priority", priority)
                if suggested != priority:
                    priority = suggested  # Use predicted priority
                    prediction_hint += f"Priority calibrated to {priority} ({priority_pred.get('reasoning', '')}). "

            cycle_pred = predict_cycle_time(project_path, intent)
            if cycle_pred.get("predicted_hours") is not None:
                hrs = cycle_pred["predicted_hours"]
                low = cycle_pred.get("range_low", hrs)
                high = cycle_pred.get("range_high", hrs)
                prediction_hint += f"Estimated: {low}-{high}h (median {hrs}h from {cycle_pred.get('sample_size', 0)} tasks)."
        except Exception:
            pass

        # Auto-complete previous task if we're pivoting
        if state["active_task_id"] and state["task_auto_created"]:
            # Don't auto-complete — just note the pivot
            _tool_log_step({
                "project_path": project_path,
                "message": f"Pivoting from {state['active_task_id']} to new work",
            })

        # Create new task
        try:
            create_result = _tool_create_task({
                "project_path": project_path,
                "title": title,
                "priority": priority,
                "owner": "Agent",
                "tags": ["auto-created"],
            })

            # Extract task ID from result (may be receipt+JSON or plain JSON)
            content = create_result.get("content", [{}])
            new_id = ""
            if content and isinstance(content, list):
                text = content[0].get("text", "")
                # Receipt format: receipt text + \n\n + JSON
                # Try to find JSON part after receipt
                for segment in [text, text.split("\n\n")[-1] if "\n\n" in text else ""]:
                    segment = segment.strip()
                    if segment.startswith("{"):
                        try:
                            data = json.loads(segment)
                            new_id = data.get("created", "")
                            if new_id:
                                break
                        except (json.JSONDecodeError, TypeError):
                            continue

            if new_id:
                # Set to IN_PROGRESS immediately
                _tool_update_task({
                    "project_path": project_path,
                    "task_id": new_id,
                    "status": "IN_PROGRESS",
                })
                _tool_log_step({
                    "project_path": project_path,
                    "message": f"Auto-created {new_id}: {title}",
                })

                state["active_task_id"] = new_id
                state["task_auto_created"] = True
                state["phase"] = "working"
                state["intent"] = intent
                state["user_prompt_summary"] = prompt[:200]
                state["original_priority"] = priority
                state["intent_match_layer"] = result.get("match_layer")

                output_lines.append(
                    f"[VaultOps] Auto-created {new_id}: \"{title}\" [{priority}, IN_PROGRESS]"
                )
                if prediction_hint:
                    output_lines.append(f"[Predictive Brain] {prediction_hint}")
                # Risk-based verify suggestion
                try:
                    risk = predict_risk(project_path, [])  # No files yet, but check history
                    if risk.get("risk_level") in ("medium", "high"):
                        output_lines.append(
                            f"[Predictive Brain] Risk: {risk['risk_level'].upper()}. "
                            f"Consider adding verify: checks to {new_id}."
                        )
                except Exception:
                    pass
                output_lines.append("Task tracking active. Evidence will be collected automatically.")
                output_lines.append("")
                output_lines.append(f"VAULTOPS_NEW_TASK: {new_id}")
                output_lines.append("INSTRUCTION: A new task was just created. Before responding to the user,")
                output_lines.append("use AskUserQuestion to offer role enrichment with two options:")
                output_lines.append(f"  Question: \"{new_id} создана. Запустить анализ ролей?\"")
                output_lines.append("  Option 1 — Сейчас: BA → (Designer ║ SysAnalyst) → Developer → QA")
                output_lines.append("    Full plan ready: stories, UX, architecture, code plan, tests")
                output_lines.append("  Option 2 — Позже: continue answering, task is already tracked")
                output_lines.append(f"    /vault:enrich {new_id} — when ready")
                output_lines.append("If user picks Option 1: immediately run /vault:enrich on this task.")
                output_lines.append("If user picks Option 2: continue normally without enrichment.")
        except Exception:
            # Silently fail — don't break user flow
            pass

    save_state(project_path, state)

    if output_lines:
        print(json.dumps({"additionalContext": "\n".join(output_lines)}))


if __name__ == "__main__":
    main()
