from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ..config import SEARCH_FIND_TYPES
from .ir import (
    ActionName,
    AllocateTask,
    FollowTask,
    FormTask,
    GoToTask,
    GroupSpec,
    HoldTask,
    InvestigateTask,
    Overlays,
    SearchTask,
)

HandlerFn = Callable[..., None]
ValidateFn = Callable[..., Optional[str]]


@dataclass
class Skill:
    name: str
    model: type
    prompt: str
    timeout: float
    handler: Optional[HandlerFn] = None
    validate: Optional[ValidateFn] = None


SKILLS: tuple[Skill, ...] = (
    Skill(
        "Allocate",
        AllocateTask,
        "Split the swarm into named groups with optional roles and counts.",
        0.5,
    ),
    Skill(
        "GoTo",
        GoToTask,
        "Move agents to target (bbox_center, sw_corner, se_corner, nw_corner, ne_corner) or a named object_id.",
        20.0,
    ),
    Skill(
        "Form",
        FormTask,
        "Place agents on a shape at target or object_id: circle, line, perimeter, grid, square, or triangle.",
        25.0,
    ),
    Skill(
        "Search",
        SearchTask,
        "Cover object_id or target with a lawnmower, or the whole bbox if omitted. object_id person or vehicle means search until that type is found.",
        60.0,
    ),
    Skill(
        "Hold",
        HoldTask,
        "Loiter at current positions, or at target / object_id.",
        1e9,
    ),
    Skill(
        "Investigate",
        InvestigateTask,
        "Move to a named object_id and hold at standoff. Omit object_id (or use person / last_contact) to bind the latest detected contact at runtime.",
        40.0,
    ),
    Skill(
        "Follow",
        FollowTask,
        "Keep a subset at standoff on a named object_id as it moves. Omit object_id (or use vehicle / last_contact) to bind the latest detected contact at runtime.",
        1e9,
    ),
)

SKILL_BY_NAME: dict[str, Skill] = {s.name: s for s in SKILLS}

assert {s.name for s in SKILLS} == {a.value for a in ActionName}


def bind(name: str, *, handler: HandlerFn | None = None, validate: ValidateFn | None = None) -> None:
    skill = SKILL_BY_NAME[name]
    if handler is not None:
        skill.handler = handler
    if validate is not None:
        skill.validate = validate


def skill_timeout(name: str, default: float = 20.0) -> float:
    skill = SKILL_BY_NAME.get(name)
    if skill is None:
        return default
    return skill.timeout


def search_find_type(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    key = str(name).lower()
    if key in SEARCH_FIND_TYPES:
        return key
    return None


def registry_prompt() -> str:
    lines = [
        "You are a mission planner for a swarm of autonomous agents.",
        "Return a PlannerResponse JSON object only (no markdown).",
        "If the request cannot be grounded in these skills, set unsupported=true and error to a short reason.",
        "Otherwise set unsupported=false and fill plan with 1-6 sequential tasks.",
        "Do not emit success or fail predicates. Omit assignment to command all agents.",
        "Places are target or object_id, not coordinates. Investigate and Follow may omit object_id to bind the latest detected person or vehicle at runtime.",
        "Put Investigate, Follow, or Form in tasks after Search only when the operator asks for that next. Emit on_event only for reactions (another contact, Lost, Moved, Reacquired).",
        "Known places are already on the COP; do not Investigate them and do not emit one task per place.",
        "Do not use undetected person or vehicle names. Use object_id person or vehicle, or omit it. Detected is an on_event when-value, never an object_id.",
        "Omit Search target and object_id to cover the whole map. Do not set target bbox_center on Search.",
        "Runtime binds detected names onto later tasks and on_event then-templates.",
        "",
        "Skills:",
    ]
    for skill in SKILLS:
        schema = skill.model.model_json_schema()
        props = sorted(
            k for k in schema.get("properties", {}) if k not in ("action",)
        )
        lines.append(f"- {skill.name}: {skill.prompt} Fields: {', '.join(props)}.")
    lines.append(
        "Plan: {version, tasks, groups, overlays:{avoid:[object names], cruise_altitude}, "
        "on_event:[{when:Detected|Lost|Moved|Reacquired, object_type, then:Task}]}."
    )
    return "\n".join(lines)


def _inline_refs(schema: dict) -> dict:
    defs = dict(schema.get("$defs") or schema.get("definitions") or {})

    def resolve(node: Any, stack: frozenset[str]) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = str(node["$ref"]).rsplit("/", 1)[-1]
                if name in stack:
                    return {"type": "object"}
                target = defs.get(name)
                if target is None:
                    return {k: v for k, v in node.items() if k != "$ref"}
                extra = {k: v for k, v in node.items() if k != "$ref"}
                inlined = resolve(copy.deepcopy(target), stack | {name})
                if extra:
                    if isinstance(inlined, dict):
                        merged = dict(inlined)
                        for key, value in extra.items():
                            if key not in merged:
                                merged[key] = resolve(value, stack)
                        return merged
                return inlined
            return {
                k: resolve(v, stack)
                for k, v in node.items()
                if k not in ("$defs", "definitions")
            }
        if isinstance(node, list):
            return [resolve(v, stack) for v in node]
        return node

    return resolve(schema, frozenset())


def _object_schema(model: type) -> dict:
    schema = _inline_refs(model.model_json_schema())
    schema.pop("title", None)
    schema.pop("$defs", None)
    schema.pop("definitions", None)
    if schema.get("type") == "object" or "properties" in schema:
        schema["additionalProperties"] = False
    return schema


def _task_any_of() -> dict:
    return {"anyOf": [_object_schema(skill.model) for skill in SKILLS]}


def planner_response_schema() -> dict:
    task_schema = _task_any_of()
    event_rule = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "when": {"type": "string", "enum": ["Detected", "Lost", "Moved", "Reacquired"]},
            "object_type": {"type": "string"},
            "then": task_schema,
        },
        "required": ["when", "object_type", "then"],
    }
    plan_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "version": {"type": "integer"},
            "tasks": {"type": "array", "items": task_schema},
            "groups": {"type": "array", "items": _object_schema(GroupSpec)},
            "overlays": _object_schema(Overlays),
            "on_event": {"type": "array", "items": event_rule},
        },
        "required": ["tasks"],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "unsupported": {"type": "boolean"},
            "error": {"type": ["string", "null"]},
            "plan": {"anyOf": [plan_schema, {"type": "null"}]},
        },
        "required": ["unsupported"],
    }
