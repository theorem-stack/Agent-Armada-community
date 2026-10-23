from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..config import OBJECT_CATALOG, SEARCH_FIND_TYPES
from ..geometry.generators import FORM_SHAPES
from .ir import (
    AllocateTask,
    FollowTask,
    FormTask,
    GoToTask,
    HoldTask,
    InvestigateTask,
    SearchTask,
    action_key,
)
from .skills import SKILL_BY_NAME, SKILLS, bind

if TYPE_CHECKING:
    from .ir import Plan, Task
    from ..session.world import WorldState


def _validate_noop(task, world, plan) -> Optional[str]:
    return None


def _is_contact_query(name: Optional[str]) -> bool:
    if not name:
        return True
    key = name.lower()
    return key in OBJECT_CATALOG or key == "last_contact"


def _is_find_query(name: Optional[str]) -> bool:
    if not name:
        return True
    key = name.lower()
    return key in SEARCH_FIND_TYPES or key == "last_contact"


def _event_syntax_id(name: Optional[str]) -> bool:
    if not name:
        return False
    key = str(name).strip()
    return "(" in key or key.lower().startswith("detected")


def _validate_object_id_syntax(task) -> Optional[str]:
    object_id = getattr(task, "object_id", None)
    if _event_syntax_id(object_id):
        return f"Task '{task.id}' object_id must be a name or type, not '{object_id}'."
    return None


def _validate_hidden_find_name(task, world, plan) -> Optional[str]:
    object_id = getattr(task, "object_id", None)
    if not object_id or _is_contact_query(object_id):
        return None
    bound = world.space.bind(object_id)
    if bound is None or bound.object_type not in SEARCH_FIND_TYPES:
        return None
    if bound.detected:
        return None
    if not any(isinstance(item, SearchTask) for item in plan.tasks):
        return None
    return (
        f"Task '{task.id}' cannot name undetected '{object_id}'; "
        f"use object_id '{bound.object_type}' or omit it."
    )


def _validate_place(task, world) -> Optional[str]:
    err = _validate_object_id_syntax(task)
    if err:
        return err
    object_id = getattr(task, "object_id", None)
    if object_id and not _is_contact_query(object_id) and world.space.anchor(object_id) is None:
        return f"Task '{task.id}' unknown object_id '{object_id}'."
    target = getattr(task, "target", None)
    if target and world.space.anchor(target) is None:
        return f"Task '{task.id}' unknown target '{target}'."
    return None


def _validate_goto(task: GoToTask, world, plan) -> Optional[str]:
    err = _validate_place(task, world)
    if err:
        return err
    return _validate_hidden_find_name(task, world, plan)


def _validate_form(task: FormTask, world, plan) -> Optional[str]:
    if task.shape not in FORM_SHAPES:
        return f"Task '{task.id}' Form shape must be one of {FORM_SHAPES}."
    err = _validate_place(task, world)
    if err:
        return err
    return _validate_hidden_find_name(task, world, plan)


def _validate_search(task: SearchTask, world, plan) -> Optional[str]:
    if task.pattern != "lawnmower":
        return f"Task '{task.id}' Search pattern must be 'lawnmower'."
    return _validate_place(task, world)


def _validate_hold(task: HoldTask, world, plan) -> Optional[str]:
    err = _validate_place(task, world)
    if err:
        return err
    return _validate_hidden_find_name(task, world, plan)


def _validate_track_task(task, world, plan) -> Optional[str]:
    err = _validate_object_id_syntax(task)
    if err:
        return err
    object_id = getattr(task, "object_id", None)
    if _is_find_query(object_id):
        return None
    bound = world.space.bind(object_id)
    if bound is None:
        return f"Task '{task.id}' {action_key(task)} unknown object '{object_id}'."
    if bound.object_type not in SEARCH_FIND_TYPES:
        return f"Task '{task.id}' {action_key(task)} is for person or vehicle, not '{object_id}'."
    return _validate_hidden_find_name(task, world, plan)


def _validate_investigate(task: InvestigateTask, world, plan) -> Optional[str]:
    return _validate_track_task(task, world, plan)


def _validate_follow(task: FollowTask, world, plan) -> Optional[str]:
    return _validate_track_task(task, world, plan)


def validate_plan(plan: "Plan", world: "WorldState") -> tuple[bool, str]:
    if not plan.tasks:
        return False, "Plan must include at least one task."

    n = len(world.agents)
    if n == 0:
        return False, "World has no agents."

    agent_ids = {a.id for a in world.agents}
    group_names = {g.name for g in plan.groups}

    for spec in plan.groups:
        if spec.agent_ids:
            missing = set(spec.agent_ids) - agent_ids
            if missing:
                return False, f"Group '{spec.name}' references unknown agent ids: {sorted(missing)}."
        if spec.count is not None and spec.count < 0:
            return False, f"Group '{spec.name}' has invalid count {spec.count}."

    for task in plan.tasks:
        if not task.id:
            return False, "Plan tasks must include a non-empty id."
        name = action_key(task)
        if name not in SKILL_BY_NAME:
            return False, f"Task '{task.id}' has unknown action '{name}'."

        if task.agent_ids is not None:
            if not task.agent_ids:
                return False, f"Task '{task.id}' has an empty agent_ids assignment."
            missing = set(task.agent_ids) - agent_ids
            if missing:
                return False, f"Task '{task.id}' references unknown agent ids: {sorted(missing)}."
        if task.group and task.group not in group_names and not isinstance(task, AllocateTask):
            params_groups = set()
            if isinstance(task, AllocateTask) and task.groups:
                params_groups = {g.name for g in task.groups}
            prior_alloc = any(isinstance(t, AllocateTask) for t in plan.tasks)
            if task.group not in params_groups and not prior_alloc and task.group not in group_names:
                return False, f"Task '{task.id}' references unknown group '{task.group}'."

        skill = SKILL_BY_NAME.get(name)
        if skill is not None and skill.validate is not None:
            err = skill.validate(task, world, plan)
            if err:
                return False, err

    for rule in plan.on_event:
        then_name = action_key(rule.then)
        if then_name not in SKILL_BY_NAME:
            return False, f"on_event then-action '{then_name}' is unknown."
        skill = SKILL_BY_NAME.get(then_name)
        if skill is not None and skill.validate is not None:
            err = skill.validate(rule.then, world, plan)
            if err:
                return False, err

    for name in plan.overlays.avoid:
        if world.space.bind(name) is None:
            return False, f"Avoid overlay references unknown object '{name}'."

    return True, ""


bind("Allocate", validate=_validate_noop)
bind("GoTo", validate=_validate_goto)
bind("Form", validate=_validate_form)
bind("Search", validate=_validate_search)
bind("Hold", validate=_validate_hold)
bind("Investigate", validate=_validate_investigate)
bind("Follow", validate=_validate_follow)

_missing_validate = [s.name for s in SKILLS if s.validate is None]
assert not _missing_validate, f"Skills missing validate: {_missing_validate}"
