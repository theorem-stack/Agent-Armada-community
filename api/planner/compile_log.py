from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from ..plan.ir import action_key

LOG_PATH = Path(__file__).resolve().parents[2] / "logs" / "compile.jsonl"

_TASK_KEYS = ("target", "object_id", "shape", "pattern")


def compile_record(statement: str, result: dict) -> dict:
    plan = result.get("plan")
    tasks = []
    events = []
    if plan is not None:
        for task in getattr(plan, "tasks", []) or []:
            item = {"action": action_key(task)}
            for key in _TASK_KEYS:
                value = getattr(task, key, None)
                if value is not None:
                    item[key] = value
            tasks.append(item)
        for rule in getattr(plan, "on_event", []) or []:
            events.append(
                {
                    "when": getattr(rule, "when", None),
                    "object_type": getattr(rule, "object_type", None),
                    "then": action_key(rule.then) if getattr(rule, "then", None) is not None else None,
                }
            )
    error = result.get("error") or ""
    unsupported = bool(result.get("unsupported")) or "unsupported" in error.lower()
    record = {
        "statement": statement,
        "ok": bool(result.get("ok")),
        "repairs": result.get("repairs"),
        "error": result.get("error"),
        "model": result.get("model"),
        "unsupported": unsupported,
        "tasks": tasks,
    }
    if events:
        record["on_event"] = events
    return record


def append_compile_log(statement: str, result: dict, path: Optional[Path] = None) -> Path:
    dest = Path(path) if path is not None else LOG_PATH
    if path is None and str(result.get("model") or "") == "fake":
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("a") as handle:
        handle.write(json.dumps(compile_record(statement, result), default=str) + "\n")
    return dest
