from __future__ import annotations

from typing import TYPE_CHECKING, Optional

import numpy as np

from ..config import INVESTIGATE_COUNT, INVESTIGATE_STANDOFF, RADIUS
from ..geometry.generators import form_points, lawnmower
from ..geometry.regions import bbox_region
from ..simulation.target import Target
from .ir import (
    AllocateTask,
    GoToTask,
    Plan,
    Task,
    action_key,
)
from .skills import SKILL_BY_NAME, SKILLS, bind, search_find_type

if TYPE_CHECKING:
    from ..session.world import WorldState
    from ..simulation.agent import Agent


class TaskRuntime:
    def __init__(self):
        self.mode = "hold"
        self.paths: dict[int, list[tuple[float, float]]] = {}
        self.path_index: dict[int, int] = {}
        self.setpoints: dict[int, tuple[float, float]] = {}
        self.assigned_ids: list[int] = []
        self.targets: dict[int, Target] = {}
        self.object_id: Optional[str] = None
        self.standoff: float = INVESTIGATE_STANDOFF

    def setpoint_targets(self) -> dict[int, Target]:
        return self.targets


def resolve_agents(task: Task, world: "WorldState") -> list["Agent"]:
    if task.agent_ids:
        ids = set(task.agent_ids)
        return [a for a in world.agents if a.id in ids]
    if task.group:
        return [a for a in world.agents if a.group == task.group]
    return list(world.agents)


def _place_name(task) -> Optional[str]:
    return getattr(task, "object_id", None) or getattr(task, "target", None)


def _write_bound_name(task, bound) -> None:
    if bound is None or bound.object_type == "anchor":
        return
    if hasattr(task, "object_id"):
        task.object_id = bound.name


def _resolve_place(task, world: "WorldState"):
    name = _place_name(task)
    if not name:
        return None
    bound = world.space.resolve_object(name)
    if bound is None:
        raise ValueError(f"Unknown place '{name}'")
    _write_bound_name(task, bound)
    return bound


def _hold_setpoints(agents: list["Agent"]) -> dict[int, tuple[float, float]]:
    return {a.id: (float(a.position[0]), float(a.position[1])) for a in agents}


def _apply_allocate(task: AllocateTask, world: "WorldState", plan: Plan) -> dict[int, tuple[float, float]]:
    specs = [g.model_dump() for g in (task.groups or [])]
    if not specs:
        specs = [g.model_dump() for g in plan.groups]
    world.groups.clear()
    for agent in world.agents:
        agent.group = None
        agent.role = None
    remaining = [a.id for a in world.agents]
    for spec in specs or []:
        name = spec["name"]
        ids = spec.get("agent_ids")
        if ids is None:
            count = spec.get("count")
            if count is None:
                count = len(remaining)
            ids = remaining[: int(count)]
        remaining = [i for i in remaining if i not in ids]
        world.groups[name] = list(ids)
        for aid in ids:
            agent = world.agent_by_id(aid)
            if agent is None:
                continue
            agent.group = name
            if spec.get("role"):
                agent.role = spec["role"]
    return _hold_setpoints(world.agents)


def _goto_setpoints(task: GoToTask, agents: list["Agent"], world: "WorldState") -> dict[int, tuple[float, float]]:
    bound = _resolve_place(task, world)
    point = bound.position if bound is not None else world.space.center()
    return {a.id: point for a in agents}


def _handle_allocate(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.mode = "allocate"
    runtime.setpoints = _apply_allocate(task, world, plan)


def _handle_goto(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.mode = "goto"
    runtime.setpoints = {**hold_others, **_goto_setpoints(task, agents, world)}


def _handle_form(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.mode = "form"
    bound = _resolve_place(task, world)
    if bound is None:
        region = bbox_region(world.bbox)
        center = region.center
        radius = None
    else:
        region = bound.region
        center = bound.position
        radius = max(min(region.width, region.height) / 4.0, INVESTIGATE_STANDOFF)
    points = form_points(len(agents), task.shape, region, center, radius=radius)
    runtime.setpoints = {**hold_others, **{agent.id: points[i] for i, agent in enumerate(agents)}}


def _search_sites(agents: list["Agent"], world: "WorldState") -> dict[str, tuple[tuple[float, float], list]]:
    sites: dict[str, tuple[tuple[float, float], list]] = {}
    if world.groups:
        for name, ids in world.groups.items():
            members = [a for a in agents if a.id in ids]
            if not members:
                continue
            cx = sum(float(a.position[0]) for a in members) / len(members)
            cy = sum(float(a.position[1]) for a in members) / len(members)
            sites[name] = ((cx, cy), members)
    if not sites:
        for agent in agents:
            sites[f"a{agent.id}"] = (
                (float(agent.position[0]), float(agent.position[1])),
                [agent],
            )
    return sites


def _apply_search_path(runtime: TaskRuntime, members: list, path: list[tuple[float, float]]) -> None:
    if not path:
        return
    for i, agent in enumerate(members):
        runtime.paths[agent.id] = path
        idx = (i * max(1, len(path) // max(len(members), 1))) % len(path)
        runtime.path_index[agent.id] = idx
        runtime.setpoints[agent.id] = path[idx]


def _resume_search(runtime: TaskRuntime, agents: list, world: "WorldState") -> None:
    if not agents:
        return
    spacing = RADIUS / 2
    sites = _search_sites(agents, world)
    assignment = world.space.assign_sectors({name: pos for name, (pos, _) in sites.items()})
    for name, (_pos, members) in sites.items():
        path: list[tuple[float, float]] = []
        for sector in assignment.get(name, []):
            path.extend(lawnmower(sector.region, heading=0.0, spacing=spacing))
        if not path:
            path = lawnmower(bbox_region(world.bbox), heading=0.0, spacing=spacing)
        _apply_search_path(runtime, members, path)


def _handle_search(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.mode = "search"
    spacing = RADIUS / 2
    runtime.setpoints = dict(hold_others)
    if search_find_type(getattr(task, "object_id", None)):
        _resume_search(runtime, agents, world)
        return
    bound = _resolve_place(task, world)
    if bound is not None:
        _apply_search_path(runtime, agents, lawnmower(bound.region, heading=0.0, spacing=spacing))
        return
    _resume_search(runtime, agents, world)


def _handle_hold(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.mode = "hold"
    bound = _resolve_place(task, world)
    if bound is not None:
        runtime.setpoints = {**hold_others, **{a.id: bound.position for a in agents}}
    else:
        runtime.setpoints = {**hold_others, **_hold_setpoints(agents)}


def _peel_standoff(runtime: TaskRuntime, task, agents, world, mode: str) -> None:
    standoff = float(task.standoff if getattr(task, "standoff", None) is not None else INVESTIGATE_STANDOFF)
    object_id = getattr(task, "object_id", None)
    prefer = "vehicle" if mode == "follow" else "person"
    bound = world.space.resolve_object(object_id, prefer_type=prefer)
    if bound is None:
        raise ValueError(f"No detected {prefer} to {mode}")
    _write_bound_name(task, bound)
    object_id = bound.name
    point = world.space.standoff(object_id, world.space.center(), standoff)
    if point is None:
        raise ValueError(f"Unknown object '{object_id}'")
    world.space.observe_occupied(*bound.position)
    poses = {a.id: (float(a.position[0]), float(a.position[1])) for a in agents}
    chosen = set(world.space.nearest_ids(bound.position, poses, INVESTIGATE_COUNT))
    investigators = [a for a in agents if a.id in chosen]
    searchers = [a for a in agents if a.id not in chosen]
    runtime.mode = mode
    runtime.object_id = object_id
    runtime.standoff = standoff
    runtime.assigned_ids = [a.id for a in investigators]
    for agent in investigators:
        runtime.setpoints[agent.id] = point
    _resume_search(runtime, searchers, world)


def _handle_investigate(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.setpoints = dict(hold_others)
    _peel_standoff(runtime, task, agents, world, "investigate")


def _handle_follow(runtime: TaskRuntime, task, agents, world, plan, hold_others) -> None:
    runtime.setpoints = dict(hold_others)
    _peel_standoff(runtime, task, agents, world, "follow")


def rebind_track(runtime: TaskRuntime, world: "WorldState") -> None:
    if runtime.mode not in ("investigate", "follow"):
        return
    if not runtime.object_id:
        return
    point = world.space.standoff(runtime.object_id, world.space.center(), runtime.standoff)
    if point is None:
        return
    for aid in runtime.assigned_ids:
        runtime.setpoints[aid] = point
        target = runtime.targets.get(aid)
        if target is not None:
            target.position = np.array(point, dtype=float)


def activate_task(task: Optional[Task], world: "WorldState", plan: Optional[Plan]) -> TaskRuntime:
    runtime = TaskRuntime()
    if task is None or plan is None:
        runtime.mode = "hold"
        runtime.assigned_ids = [a.id for a in world.agents]
        runtime.setpoints = _hold_setpoints(world.agents)
        runtime.targets = {
            aid: Target(aid, np.array(pt, dtype=float), 10)
            for aid, pt in runtime.setpoints.items()
        }
        return runtime

    agents = resolve_agents(task, world)
    runtime.assigned_ids = [a.id for a in agents]
    others = [a for a in world.agents if a.id not in runtime.assigned_ids]
    hold_others = _hold_setpoints(others)

    skill = SKILL_BY_NAME.get(action_key(task))
    if skill is None or skill.handler is None:
        raise ValueError(f"Skill '{action_key(task)}' has no handler")
    skill.handler(runtime, task, agents, world, plan, hold_others)

    runtime.targets = {
        aid: Target(aid, np.array(pt, dtype=float), 10)
        for aid, pt in runtime.setpoints.items()
    }
    return runtime


def advance_search(runtime: TaskRuntime, world: "WorldState", tolerance: float) -> None:
    for agent in world.agents:
        path = runtime.paths.get(agent.id)
        if not path:
            continue
        idx = runtime.path_index.get(agent.id, 0)
        sp = path[idx]
        dx = float(agent.position[0]) - sp[0]
        dy = float(agent.position[1]) - sp[1]
        if (dx * dx + dy * dy) ** 0.5 <= tolerance:
            idx = (idx + 1) % len(path)
            runtime.path_index[agent.id] = idx
            runtime.setpoints[agent.id] = path[idx]
            runtime.targets[agent.id].position = np.array(path[idx], dtype=float)


bind("Allocate", handler=_handle_allocate)
bind("GoTo", handler=_handle_goto)
bind("Form", handler=_handle_form)
bind("Search", handler=_handle_search)
bind("Hold", handler=_handle_hold)
bind("Investigate", handler=_handle_investigate)
bind("Follow", handler=_handle_follow)

_missing_handlers = [s.name for s in SKILLS if s.handler is None]
assert not _missing_handlers, f"Skills missing handlers: {_missing_handlers}"
