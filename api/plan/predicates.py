from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..config import EVAL_TOLERANCE, SEARCH_COVER_MIN, SEARCH_FIND_TYPES
from ..geometry.regions import Region, point_in_region
from .ir import (
    ActionName,
    Predicate,
    PredicateAgentsInRegion,
    PredicateCoverage,
    PredicateDetected,
    PredicateTimeout,
    SearchTask,
    Task,
    action_key,
)
from .skills import search_find_type, skill_timeout

if TYPE_CHECKING:
    from ..session.world import WorldState

_TASK_BOUNDARY_EVENTS = ("plan", "task_success", "task_fail")


def default_fail(task: Task) -> PredicateTimeout:
    return PredicateTimeout(seconds=skill_timeout(action_key(task)))


def _events_since_task_start(world: "WorldState", started_at: float) -> list[dict]:
    start = 0
    for i, event in enumerate(world.events):
        if event.get("type") in _TASK_BOUNDARY_EVENTS and float(event.get("t", 0)) <= started_at:
            start = i + 1
    return world.events[start:]


def _search_find_types(task: Task) -> tuple[str, ...]:
    typed = search_find_type(getattr(task, "object_id", None))
    if typed:
        return (typed,)
    return SEARCH_FIND_TYPES


def _search_found_interest(world: "WorldState", task: Task, started_at: float) -> bool:
    wanted = _search_find_types(task)
    for event in _events_since_task_start(world, started_at):
        if event.get("type") != "detection":
            continue
        kind = str(event.get("object_type") or "").lower()
        if kind in wanted:
            return True
    return False


def eval_success(
    predicate: Optional[Predicate],
    task: Task,
    world: "WorldState",
    assigned_ids: list[int],
    started_at: float,
    setpoints: dict[int, tuple[float, float]],
) -> bool:
    if predicate is None:
        key = action_key(task)
        if key == ActionName.allocate.value:
            return True
        if key == ActionName.hold.value or key == ActionName.follow.value:
            return False
        if key == ActionName.search.value:
            if _search_found_interest(world, task, started_at):
                return True
            return eval_success(
                PredicateCoverage(min=SEARCH_COVER_MIN),
                task,
                world,
                assigned_ids,
                started_at,
                setpoints,
            )
        return eval_success(
            PredicateAgentsInRegion(),
            task,
            world,
            assigned_ids,
            started_at,
            setpoints,
        )

    if isinstance(predicate, PredicateTimeout):
        seconds = predicate.seconds if predicate.seconds is not None else skill_timeout(action_key(task))
        return (world.sim_time - started_at) >= seconds

    if isinstance(predicate, PredicateAgentsInRegion):
        agents = [a for a in world.agents if a.id in assigned_ids]
        if not agents:
            return False
        min_count = predicate.min_count if predicate.min_count is not None else len(agents)
        pad = predicate.pad if predicate.pad else EVAL_TOLERANCE
        if predicate.region is not None:
            region = predicate.region
            inside = sum(1 for a in agents if point_in_region(a.position, region, pad=pad))
            return inside >= min_count
        arrived = 0
        for agent in agents:
            sp = setpoints.get(agent.id)
            if sp is None:
                continue
            dx = float(agent.position[0]) - float(sp[0])
            dy = float(agent.position[1]) - float(sp[1])
            if (dx * dx + dy * dy) ** 0.5 <= EVAL_TOLERANCE:
                arrived += 1
        return arrived >= min_count

    if isinstance(predicate, PredicateDetected):
        count = sum(
            1
            for obj in world.map_objects
            if obj.detected and obj.object_type == predicate.object_type.lower()
        )
        return count >= predicate.min_count

    if isinstance(predicate, PredicateCoverage):
        region = predicate.region
        if region is None and isinstance(task, SearchTask):
            place = getattr(task, "object_id", None) or getattr(task, "target", None)
            if place and search_find_type(place) is None:
                bound = world.space.anchor(place)
                if bound is not None:
                    region = bound.region
        if isinstance(region, dict):
            region = Region.model_validate(region)
        return world.coverage.fraction(region) >= predicate.min

    return False


def eval_fail(
    predicate: Optional[Predicate],
    task: Task,
    world: "WorldState",
    started_at: float,
) -> bool:
    fail = default_fail(task)
    seconds = fail.seconds if fail.seconds is not None else skill_timeout(action_key(task))
    return (world.sim_time - started_at) >= seconds
