from __future__ import annotations

from typing import TYPE_CHECKING

from ..config import SEARCH_FIND_TYPES, START_DETECTED_TYPES

if TYPE_CHECKING:
    from ..geometry.kernel import BoundSymbol
    from ..session.world import WorldState


def _named(bound: "BoundSymbol") -> dict:
    return {
        "name": bound.name,
        "type": bound.object_type,
        "condition": bound.condition,
    }


def compact_world_summary(world: "WorldState") -> dict:
    space = world.space
    known = list(space.detected())
    summary = {
        "n_agents": len(world.agents),
        "bbox": world.bbox,
        "places": [
            {"name": bound.name, "type": bound.object_type}
            for bound in known
            if bound.object_type in START_DETECTED_TYPES
        ],
        "detected": [
            _named(bound)
            for bound in known
            if bound.object_type in SEARCH_FIND_TYPES
        ],
        "undetected_counts": space.undetected_counts(),
        "uncovered_mass": round(space.uncovered_mass(), 4),
    }
    if world.groups:
        summary["groups"] = dict(world.groups)
    return summary
