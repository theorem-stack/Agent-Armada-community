from __future__ import annotations

import math
from typing import Optional

from ..config import (
    CONTACT_SPEED,
    COVERAGE_CELL_SIZE,
    DEFAULT_SPAWN,
    DEFAULT_Z,
    ENV_HEIGHT,
    ENV_WIDTH,
    NUM_AGENTS,
    OBJECT_CATALOG,
    OBJECTS_OF_INTEREST,
    SPAWN_RADIUS,
    START_DETECTED_TYPES,
)
from ..simulation.mapObject import wrap_heading
from ..geometry.coverage import CoverageGrid, OccupancyGrid
from ..geometry.generators import sample_circle
from ..geometry.kernel import SpatialKernel
from ..lib.dataProcessing import detected_objects_filter
from ..simulation.agent import Agent
from ..simulation.environment import create_agents_from_dict
from ..simulation.mapObject import mapObject
from ..simulation.maps import maps


def clone_map(map_name: str) -> list[mapObject]:
    if map_name not in maps:
        raise KeyError(f"Unknown map '{map_name}'")
    clones = []
    for obj in maps[map_name]:
        pos = obj.position.tolist() if hasattr(obj.position, "tolist") else list(obj.position)
        props = dict(obj.properties) if obj.properties else None
        clones.append(
            mapObject(
                obj.name,
                pos,
                obj.boundingBox,
                obj.object_type,
                obj.condition,
                props,
                heading=getattr(obj, "heading", 0.0),
                footprint=getattr(obj, "footprint", None),
            )
        )
    return detected_objects_filter(clones, start_types=START_DETECTED_TYPES)


def clamp_spawn(point, bbox) -> tuple[float, float]:
    x1, y1, x2, y2 = (float(v) for v in bbox)
    x, y = float(point[0]), float(point[1])
    return (min(max(x, x1), x2), min(max(y, y1), y2))


class WorldState:
    def __init__(
        self,
        map_name: str,
        n_agents: int = NUM_AGENTS,
        spawn: Optional[tuple[float, float]] = None,
    ):
        self.map_name = map_name
        self.bbox = [0.0, 0.0, float(ENV_WIDTH), float(ENV_HEIGHT)]
        self.map_objects = clone_map(map_name)
        self.coverage = CoverageGrid(ENV_WIDTH, ENV_HEIGHT, COVERAGE_CELL_SIZE)
        self.occupancy = OccupancyGrid(self.coverage)
        self.space = SpatialKernel(self.bbox, self.map_objects, occupancy=self.occupancy)
        self.spawn = clamp_spawn(spawn or DEFAULT_SPAWN, self.bbox)
        self.agents: list[Agent] = self._spawn_agents(n_agents)
        self.events: list[dict] = []
        self.sim_time = 0.0
        self.tick = 0
        self.groups: dict[str, list[int]] = {}
        self._event_seq = 0

    def _cluster_points(self, n: int) -> list[tuple[float, float]]:
        return [clamp_spawn(point, self.bbox) for point in sample_circle(n, self.spawn, SPAWN_RADIUS)]

    def _spawn_agents(self, n: int) -> list[Agent]:
        points = self._cluster_points(n)
        agents_dict = {
            agent_id: {
                "target_id": agent_id,
                "position": [points[agent_id][0], points[agent_id][1]],
                "z_position": DEFAULT_Z,
            }
            for agent_id in range(n)
        }
        return create_agents_from_dict(agents_dict)

    def respawn(self, origin) -> tuple[float, float]:
        self.spawn = clamp_spawn(origin, self.bbox)
        points = self._cluster_points(len(self.agents))
        for agent, point in zip(self.agents, points):
            agent.position[:] = [point[0], point[1]]
            agent.z_position = DEFAULT_Z
            agent.velocity[:] = 0.0
            agent.acceleration[:] = 0.0
        return self.spawn

    def agent_by_id(self, agent_id: int) -> Optional[Agent]:
        for agent in self.agents:
            if agent.id == agent_id:
                return agent
        return None

    def object_by_name(self, name: str) -> Optional[mapObject]:
        return self.space.object(name)

    def _next_object_name(self, prefix: str) -> str:
        taken = {obj.name for obj in self.map_objects}
        index = 1
        while f"{prefix}{index}" in taken:
            index += 1
        return f"{prefix}{index}"

    def add_object(self, object_type: str, x: float, y: float) -> mapObject:
        kind = str(object_type).lower()
        spec = OBJECT_CATALOG.get(kind)
        if spec is None:
            raise ValueError(f"Unknown object type '{object_type}'")
        x, y = clamp_spawn((x, y), self.bbox)
        fw, fh = spec["footprint"]
        obj = mapObject(
            self._next_object_name(spec["prefix"]),
            [x, y],
            ((x - fw / 2.0, y - fh / 2.0), (x + fw / 2.0, y + fh / 2.0)),
            kind,
            spec["condition"],
            footprint=(fw, fh),
        )
        obj.authored = True
        obj.detected = kind in START_DETECTED_TYPES
        obj.apply_pose(x, y, 0.0)
        self.map_objects.append(obj)
        self.space.reindex()
        return obj

    def move_object(self, name: str, x=None, y=None, heading=None) -> mapObject:
        obj = self.space.object(name)
        if obj is None:
            raise KeyError(name)
        cx, cy = float(obj.position[0]), float(obj.position[1])
        if x is None:
            x = cx
        if y is None:
            y = cy
        x, y = clamp_spawn((x, y), self.bbox)
        obj.apply_pose(x, y, heading)
        self.space.reindex()
        self.space.record_motion(0.0)
        return obj

    def step_contacts(self, dt: float) -> None:
        x1, y1, x2, y2 = (float(v) for v in self.bbox)
        speed = float(CONTACT_SPEED)
        moved = False
        for obj in self.map_objects:
            if str(obj.object_type).lower() not in OBJECTS_OF_INTEREST:
                continue
            heading = wrap_heading(getattr(obj, "heading", 0.0) or 0.0)
            nx = float(obj.position[0]) + math.cos(heading) * speed * dt
            ny = float(obj.position[1]) + math.sin(heading) * speed * dt
            if nx < x1 or nx > x2:
                heading = wrap_heading(math.pi - heading)
                nx = min(max(nx, x1), x2)
            if ny < y1 or ny > y2:
                heading = wrap_heading(-heading)
                ny = min(max(ny, y1), y2)
            obj.apply_pose(nx, ny, heading)
            moved = True
        if moved:
            self.space.reindex()
        self.space.record_motion(dt)

    def remove_object(self, name: str) -> mapObject:
        obj = self.space.object(name)
        if obj is None:
            raise KeyError(name)
        self.map_objects.remove(obj)
        self.space.reindex()
        return obj

    def add_event(self, event_type: str, **payload) -> dict:
        self._event_seq += 1
        event = {"id": f"e{self._event_seq}", "t": round(self.sim_time, 3), "type": event_type, **payload}
        self.events.append(event)
        return event

    def paint_coverage(self, *, belief: bool = False) -> None:
        for agent in self.agents:
            x = float(agent.position[0])
            y = float(agent.position[1])
            self.coverage.paint(x, y)
            if belief:
                self.space.observe_free(x, y)
