from __future__ import annotations

import json
import os
import time
from typing import TYPE_CHECKING, Optional

from dotenv import load_dotenv
from openai import AsyncOpenAI

from ..config import MAX_TOKENS, OPENAI_MODEL, PLAN_REPAIR_ATTEMPTS, TEMPERATURE
from ..plan.ir import Plan, PlannerResponse
from ..plan.skills import planner_response_schema, registry_prompt
from ..plan.validate import validate_plan
from .summary import compact_world_summary

if TYPE_CHECKING:
    from ..session.world import WorldState

load_dotenv()


def fixture_plan() -> Plan:
    return Plan.model_validate(
        {
            "version": 1,
            "tasks": [
                {
                    "id": "t1",
                    "action": "GoTo",
                    "objective": "Move agents to the map center",
                    "target": "bbox_center",
                },
                {
                    "id": "t2",
                    "action": "Form",
                    "objective": "Form a circle",
                    "shape": "circle",
                },
            ],
        }
    )


def _drop_nones(value):
    if isinstance(value, dict):
        return {k: _drop_nones(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_drop_nones(v) for v in value]
    return value


def _clean_task(task):
    if not isinstance(task, dict):
        return task
    item = dict(task)
    item.pop("success", None)
    item.pop("fail", None)
    params = item.pop("params", None)
    if isinstance(params, dict):
        for key, value in params.items():
            item.setdefault(key, value)
    if str(item.get("action") or "") == "Search" and item.get("target") == "bbox_center":
        item.pop("target", None)
    return _drop_nones(item)


def _strip_predicates(payload: dict) -> dict:
    data = dict(payload)
    plan = data.get("plan")
    tasks = None
    if isinstance(plan, dict):
        plan = dict(plan)
        data["plan"] = plan
        tasks = plan.get("tasks")
        rules = plan.get("on_event")
        if isinstance(rules, list):
            cleaned_rules = []
            for rule in rules:
                if not isinstance(rule, dict):
                    cleaned_rules.append(rule)
                    continue
                item = dict(rule)
                if "then" in item:
                    item["then"] = _clean_task(item["then"])
                cleaned_rules.append(_drop_nones(item))
            plan["on_event"] = cleaned_rules
    elif "tasks" in data:
        tasks = data.get("tasks")
        rules = data.get("on_event")
        if isinstance(rules, list):
            cleaned_rules = []
            for rule in rules:
                if not isinstance(rule, dict):
                    cleaned_rules.append(rule)
                    continue
                item = dict(rule)
                if "then" in item:
                    item["then"] = _clean_task(item["then"])
                cleaned_rules.append(_drop_nones(item))
            data["on_event"] = cleaned_rules
    if isinstance(tasks, list):
        cleaned = [_clean_task(task) for task in tasks]
        if isinstance(plan, dict):
            plan["tasks"] = cleaned
        else:
            data["tasks"] = cleaned
    return _drop_nones(data)


def parse_and_validate(payload: dict, world: "WorldState") -> tuple[Plan | None, str | None]:
    data = _strip_predicates(payload)
    if data.get("unsupported"):
        return None, data.get("error") or "Mission is unsupported by the action catalog."
    try:
        if "plan" in data and data["plan"] is not None:
            parsed = PlannerResponse.model_validate(data)
            if parsed.unsupported:
                return None, parsed.error or "Mission is unsupported by the action catalog."
            plan = parsed.plan
            if plan is None:
                return None, "Planner response missing plan."
        else:
            plan = Plan.model_validate(data)
    except Exception as e:
        return None, f"Plan JSON failed schema validation: {e}"
    ok, err = validate_plan(plan, world)
    if not ok:
        return None, err
    return plan, None


def _response_format() -> dict:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "planner_response",
            "strict": False,
            "schema": planner_response_schema(),
        },
    }


async def _complete(client: AsyncOpenAI, user_message: str) -> str:
    response = await client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": registry_prompt()},
            {"role": "user", "content": user_message},
        ],
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
        response_format=_response_format(),
    )
    return response.choices[0].message.content or ""


def _user_message(statement: str, world: "WorldState", context: Optional[str] = None) -> str:
    parts = [f"Mission:\n{statement}"]
    if context:
        parts.append(f"Event context:\n{context}")
    parts.append(f"World summary:\n{json.dumps(compact_world_summary(world), default=str)}")
    return "\n\n".join(parts)


async def plan_mission(
    statement: str,
    world: "WorldState",
    context: Optional[str] = None,
) -> dict:
    started = time.monotonic()
    metrics = {"elapsed_ms": 0, "repairs": 0, "ok": False, "model": OPENAI_MODEL}

    def _done(extra: dict) -> dict:
        metrics["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        extra.update(metrics)
        return extra

    api_key = os.getenv("OPEN_AI_API_KEY")
    if not api_key:
        return _done({"ok": False, "error": "Missing OPEN_AI_API_KEY", "plan": None})

    user_message = _user_message(statement, world, context)
    client = AsyncOpenAI(api_key=api_key)

    try:
        raw = await _complete(client, user_message)
    except Exception as e:
        return _done({"ok": False, "error": f"LLM API call failed: {e}", "plan": None})

    last_error = None
    attempts = 0
    while attempts <= PLAN_REPAIR_ATTEMPTS:
        try:
            payload = json.loads(raw)
        except Exception as e:
            last_error = f"Could not parse plan JSON: {e}"
        else:
            plan, err = parse_and_validate(payload, world)
            if plan is not None:
                metrics["ok"] = True
                metrics["repairs"] = attempts
                return _done({"ok": True, "error": None, "plan": plan})
            last_error = err

        if attempts >= PLAN_REPAIR_ATTEMPTS:
            break
        repair = (
            f"{user_message}\n\nPrevious response:\n{raw}\n\n"
            f"Error:\n{last_error}\n\n"
            "Return a corrected PlannerResponse JSON only that fixes the error."
        )
        try:
            raw = await _complete(client, repair)
        except Exception as e:
            return _done({"ok": False, "error": f"LLM API call failed: {e}", "plan": None})
        attempts += 1
        metrics["repairs"] = attempts

    return _done(
        {
            "ok": False,
            "error": last_error or "Failed to generate a valid mission plan.",
            "plan": None,
        }
    )
