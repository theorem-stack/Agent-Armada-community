from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import TYPE_CHECKING, Optional

import numpy as np

from ..config import (
    ALIGNMENT_WEIGHT,
    ASSESS_DT,
    COHESION_WEIGHT,
    DEFAULT_Z,
    EVAL_TOLERANCE,
    LOST_TICKS,
    MOVE_THRESHOLD,
    OBSTACLE_WEIGHT,
    PHYSICS_DT,
    SEPARATION_WEIGHT,
    TARGET_RADIUS,
    TARGET_WEIGHT,
    TERRAIN_WEIGHT,
)
from ..plan.handlers import activate_task, advance_search, rebind_track
from ..plan.ir import GoToTask, Plan, TaskStatus, action_key
from ..plan.predicates import eval_fail, eval_success
from ..plan.validate import validate_plan
from ..planner.compile_log import append_compile_log
from ..simulation.environment import build_agent_payload
from ..simulation.obstacle import Obstacle
from .world import WorldState

if TYPE_CHECKING:
    from .store import SessionStore


class Session:
    def __init__(
        self,
        map_name: str,
        *,
        hardcoded_center: bool = False,
        spawn: Optional[tuple[float, float]] = None,
    ):
        self.id = uuid.uuid4().hex[:12]
        self.status = "idle"
        self.last_error: Optional[str] = None
        self.world = WorldState(map_name, spawn=spawn)
        self.plan: Optional[Plan] = None
        self.plan_seq = 0
        self.task_status: dict[str, str] = {}
        self.current_task_index = -1
        self.task_started_at = 0.0
        self.runtime = activate_task(None, self.world, None)
        self.obstacles: list[Obstacle] = []
        self.obstacle_weight = 0.0
        self.agent_detections: dict[int, str] = {}
        self.new_detections: list[dict] = []
        self.snapshot: dict = {}
        self._running = False
        self._physics_task: Optional[asyncio.Task] = None
        self._assess_task: Optional[asyncio.Task] = None
        self._planner_task: Optional[asyncio.Task] = None
        self._planner_fn = None
        self.mission_statement: Optional[str] = None
        self._compile_seq = 0
        self._lost_names: set[str] = set()
        self._unseen_counts: dict[str, int] = {}
        self._moved_pose: dict[str, tuple[float, float]] = {}
        self._hardcoded_center = hardcoded_center
        if hardcoded_center:
            self._apply_center_goto()
            self.status = "running"
        self._rebuild_snapshot()

    @classmethod
    def create(
        cls,
        map_name: str,
        store: Optional["SessionStore"] = None,
        *,
        hardcoded_center: bool = False,
        spawn: Optional[tuple[float, float]] = None,
    ) -> "Session":
        session = cls(map_name, hardcoded_center=hardcoded_center, spawn=spawn)
        if store is not None:
            store.add(session)
        return session

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._physics_task = asyncio.create_task(self._physics_loop())
        self._assess_task = asyncio.create_task(self._assess_loop())

    async def stop(self) -> None:
        self._running = False
        for task in (self._physics_task, self._assess_task, self._planner_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._physics_task = None
        self._assess_task = None
        self._planner_task = None

    def abort(self) -> None:
        self._end_planning_session()
        self._clear_published_plan()
        self._clear_groups()
        self.status = "idle"
        self.world.add_event("abort")
        self._rebuild_snapshot()

    def set_spawn(self, x: float, y: float) -> tuple[float, float]:
        self._end_planning_session()
        self._clear_published_plan()
        self._clear_groups()
        origin = self.world.respawn((x, y))
        self.runtime = activate_task(None, self.world, None)
        self.status = "idle"
        self.world.add_event("spawn", x=round(origin[0], 2), y=round(origin[1], 2))
        self._rebuild_snapshot()
        return origin

    def _bump_compile_seq(self) -> int:
        if self._planner_task and not self._planner_task.done():
            self._planner_task.cancel()
        self._planner_task = None
        self._compile_seq += 1
        return self._compile_seq

    def _end_planning_session(self) -> None:
        self._bump_compile_seq()
        self._planner_fn = None
        self.mission_statement = None

    def _clear_groups(self) -> None:
        self.world.groups.clear()
        for agent in self.world.agents:
            agent.group = None
            agent.role = None

    def _clear_published_plan(self) -> None:
        self.plan = None
        self.task_status = {}
        self.current_task_index = -1
        self.last_error = None
        self.obstacles = []
        self.obstacle_weight = 0.0
        self.runtime = activate_task(None, self.world, None)
        self._lost_names.clear()
        self._unseen_counts.clear()
        self._moved_pose.clear()

    def _plan_snapshot(self) -> dict:
        if self.plan is None:
            return {}
        tasks = []
        for task in self.plan.tasks:
            item = {"id": task.id, "action": action_key(task)}
            for key in ("target", "object_id", "shape", "pattern", "group"):
                value = getattr(task, key, None)
                if value is not None:
                    item[key] = value
            tasks.append(item)
        events = [
            {
                "when": rule.when,
                "object_type": rule.object_type,
                "then": action_key(rule.then),
            }
            for rule in self.plan.on_event
        ]
        snapshot = {"version": self.plan.version, "tasks": tasks}
        if events:
            snapshot["on_event"] = events
        return snapshot

    def place_object(self, object_type: str, x: float, y: float):
        obj = self.world.add_object(object_type, x, y)
        self.world.add_event(
            "place",
            object=obj.name,
            object_type=obj.object_type,
            x=round(float(obj.position[0]), 2),
            y=round(float(obj.position[1]), 2),
        )
        self._rebuild_snapshot()
        return obj

    def relocate_object(self, name: str, x=None, y=None, heading=None):
        obj = self.world.move_object(name, x, y, heading)
        self.world.add_event(
            "move",
            object=obj.name,
            x=round(float(obj.position[0]), 2),
            y=round(float(obj.position[1]), 2),
            heading=round(float(obj.heading), 4),
        )
        self._rebuild_snapshot()
        return obj

    def delete_object(self, name: str):
        obj = self.world.remove_object(name)
        self.world.add_event("delete", object=obj.name, object_type=obj.object_type)
        self._rebuild_snapshot()
        return obj

    def apply_plan(self, plan: Plan) -> tuple[bool, str]:
        ok, err = validate_plan(plan, self.world)
        if not ok:
            return False, err
        self.world.coverage.reset()
        self.world.space.reset_belief()
        self._clear_groups()
        self.plan_seq += 1
        plan.version = self.plan_seq
        self.plan = plan
        self.last_error = None
        self.task_status = {t.id: TaskStatus.pending.value for t in plan.tasks}
        self.current_task_index = 0
        self.task_started_at = self.world.sim_time
        self._apply_overlays(plan)
        if plan.tasks:
            self.task_status[plan.tasks[0].id] = TaskStatus.active.value
            try:
                self.runtime = activate_task(plan.tasks[0], self.world, plan)
            except ValueError as exc:
                self.task_status[plan.tasks[0].id] = TaskStatus.fail.value
                self.world.add_event("task_fail", task_id=plan.tasks[0].id, reason=str(exc))
                self.current_task_index = 0
                self.status = "running"
                self.world.add_event("plan", version=plan.version)
                self._advance_task()
                self._rebuild_snapshot()
                return True, ""
        else:
            self.runtime = activate_task(None, self.world, plan)
        self.status = "running"
        self.world.add_event("plan", version=plan.version)
        self._rebuild_snapshot()
        return True, ""

    def physics_tick(self, dt: float = PHYSICS_DT) -> None:
        agents = self.world.agents
        targets = self.runtime.targets
        obstacles = self.obstacles
        obs_w = self.obstacle_weight
        for agent in agents:
            target = targets.get(agent.id)
            if target is None:
                continue
            agent.edges()
            agent.flock(
                agents,
                target,
                obstacles,
                ALIGNMENT_WEIGHT,
                COHESION_WEIGHT,
                SEPARATION_WEIGHT,
                TARGET_WEIGHT,
                obs_w,
                TERRAIN_WEIGHT,
            )
            agent.update()
        self.world.step_contacts(dt)
        rebind_track(self.runtime, self.world)
        self.world.paint_coverage(
            belief=self.runtime.mode == "search" or bool(self.runtime.paths)
        )
        advance_search(self.runtime, self.world, EVAL_TOLERANCE)
        self.world.sim_time += dt
        self.world.tick += 1

    def assess_tick(self) -> None:
        self.new_detections = []
        for agent in self.world.agents:
            eye = (
                float(agent.position[0]),
                float(agent.position[1]),
                float(agent.z_position or 0),
            )
            for obj in self.world.map_objects:
                if self.world.space.visible(eye, obj):
                    self.agent_detections[agent.id] = obj.name
                    if not obj.detected:
                        obj.detected = True
                        pos = obj.position
                        self.world.space.observe_occupied(float(pos[0]), float(pos[1]))
                        payload = obj.convert_to_dict()
                        self.new_detections.append(payload)
                        self.world.add_event(
                            "detection",
                            agent_id=agent.id,
                            object=obj.name,
                            object_type=obj.object_type,
                        )
                        self.world.space.note_contact(obj.name, obj.object_type)

        handled = self._maybe_on_event(self.new_detections, when="Detected")
        unmatched = [
            d for d in self.new_detections
            if str(d.get("name", "")) not in handled
        ]
        self._maybe_replan(unmatched)

        contact_events = self._contact_events()
        for when in ("Lost", "Moved", "Reacquired"):
            batch = [e for e in contact_events if e.get("when") == when]
            self._maybe_on_event(batch, when=when)
            if when == "Lost":
                for item in batch:
                    self._fail_track_task(str(item.get("name") or ""))

        if self.plan and 0 <= self.current_task_index < len(self.plan.tasks):
            task = self.plan.tasks[self.current_task_index]
            assigned = self.runtime.assigned_ids
            if eval_success(
                None,
                task,
                self.world,
                assigned,
                self.task_started_at,
                self.runtime.setpoints,
            ):
                self.task_status[task.id] = TaskStatus.success.value
                self.world.add_event("task_success", task_id=task.id)
                self._advance_task()
            elif eval_fail(None, task, self.world, self.task_started_at):
                self.task_status[task.id] = TaskStatus.fail.value
                self.world.add_event("task_fail", task_id=task.id, reason="timeout")
                self.world.add_event("stall", task_id=task.id)
                self._advance_task()

        self._rebuild_snapshot()

    def _advance_task(self) -> None:
        if self.plan is None:
            return
        self.current_task_index += 1
        if self.current_task_index >= len(self.plan.tasks):
            self.status = "complete"
            self.runtime = activate_task(None, self.world, self.plan)
            self.world.add_event("complete", version=self.plan.version)
            return
        nxt = self.plan.tasks[self.current_task_index]
        self.task_status[nxt.id] = TaskStatus.active.value
        self.task_started_at = self.world.sim_time
        try:
            self.runtime = activate_task(nxt, self.world, self.plan)
        except ValueError as exc:
            self.task_status[nxt.id] = TaskStatus.fail.value
            self.world.add_event("task_fail", task_id=nxt.id, reason=str(exc))
            self._advance_task()

    def _apply_center_goto(self) -> None:
        plan = Plan(
            version=0,
            tasks=[
                GoToTask(
                    id="boot",
                    objective="Move to map center",
                    target="bbox_center",
                )
            ],
        )
        self.apply_plan(plan)

    def _apply_overlays(self, plan: Plan) -> None:
        alt = plan.overlays.cruise_altitude
        if alt is not None:
            for agent in self.world.agents:
                agent.z_position = float(alt)
        else:
            for agent in self.world.agents:
                if agent.z_position is None:
                    agent.z_position = DEFAULT_Z

        self.obstacles = []
        if plan.overlays.avoid:
            for i, name in enumerate(plan.overlays.avoid):
                obj = self.world.object_by_name(name)
                if obj is None:
                    continue
                pos = np.array(obj.position, dtype=float)
                radius = getattr(obj, "radius", None)
                if radius is None:
                    radius = obj._compute_radius()
                self.obstacles.append(Obstacle(i, pos, float(radius)))
            self.obstacle_weight = max(OBSTACLE_WEIGHT, 1.25)
        else:
            self.obstacle_weight = 0.0

    def _plan_progress(self) -> dict:
        if not self.plan:
            return {}
        progress = {}
        for i, task in enumerate(self.plan.tasks, start=1):
            status = self.task_status.get(task.id, TaskStatus.pending.value)
            progress[i] = {
                "objective": task.objective or f"{action_key(task)} {task.id}",
                "completed": status == TaskStatus.success.value,
                "status": status,
                "action": action_key(task),
                "task_id": task.id,
            }
        return progress

    def _targets_payload(self) -> dict:
        out = {}
        for aid, pt in self.runtime.setpoints.items():
            out[aid] = {"position": [float(pt[0]), float(pt[1])], "radius": TARGET_RADIUS}
        return out

    def _obstacles_payload(self) -> dict:
        out = {}
        for obs in self.obstacles:
            out[obs.id] = {
                "position": obs.position.tolist(),
                "radius": obs.radius,
            }
        return out

    def _rebuild_snapshot(self) -> None:
        agents = {agent.id: build_agent_payload(agent) for agent in self.world.agents}
        plan_dump = None
        if self.plan is not None:
            plan_dump = self.plan.model_dump(mode="json")
            plan_dump["task_status"] = dict(self.task_status)
            plan_dump["current_task_index"] = self.current_task_index
        eyes = {
            agent.id: (
                float(agent.position[0]),
                float(agent.position[1]),
                float(agent.z_position or 0),
            )
            for agent in self.world.agents
        }
        self.snapshot = {
            "session_id": self.id,
            "session_status": self.status,
            "error": self.last_error,
            "agents": agents,
            "targets": self._targets_payload(),
            "obstacles": self._obstacles_payload(),
            "agent_detections": {str(k): v for k, v in self.agent_detections.items()},
            "new_detections": list(self.new_detections),
            "tracks": self.world.space.fused_tracks(eyes, self.world.tick),
            "spawn": [float(self.world.spawn[0]), float(self.world.spawn[1])],
            "map_objects": [obj.convert_to_dict() for obj in self.world.map_objects],
            "plan_progress": self._plan_progress(),
            "plan": plan_dump,
            "events": list(self.world.events[-100:]),
            "coverage": self.world.coverage.summary(),
        }

    async def _physics_loop(self) -> None:
        dt = PHYSICS_DT
        try:
            while self._running:
                t0 = time.monotonic()
                self.physics_tick(dt)
                elapsed = time.monotonic() - t0
                await asyncio.sleep(max(0.0, dt - elapsed))
        except asyncio.CancelledError:
            raise

    async def _assess_loop(self) -> None:
        dt = ASSESS_DT
        try:
            while self._running:
                t0 = time.monotonic()
                self.assess_tick()
                elapsed = time.monotonic() - t0
                await asyncio.sleep(max(0.0, dt - elapsed))
        except asyncio.CancelledError:
            raise

    REPLAN_TYPES = frozenset({"person", "flood"})

    def _event_insert_index(self) -> int:
        if self.plan is None:
            return 0
        if self.current_task_index < 0 or self.current_task_index >= len(self.plan.tasks):
            return len(self.plan.tasks)
        index = self.current_task_index + 1
        while index < len(self.plan.tasks) and str(self.plan.tasks[index].id).startswith("evt-"):
            index += 1
        return index

    def _already_has_object_task(self, object_id: str, object_type: str = "") -> bool:
        if self.plan is None:
            return False
        kind = str(object_type or "").lower()
        for task in self.plan.tasks:
            if action_key(task) == "Search":
                continue
            oid = getattr(task, "object_id", None)
            if oid == object_id or task.id == f"evt-{object_id}":
                return True
            if oid and oid.lower() in {kind, "last_contact"}:
                return True
            action = action_key(task)
            if not oid:
                if kind == "person" and action == "Investigate":
                    return True
                if kind == "vehicle" and action == "Follow":
                    return True
        return False

    def _bind_event_task(self, template, detection: dict):
        name = str(detection.get("name") or "")
        action = action_key(template)
        updates = {
            "id": f"evt-{name}",
            "objective": template.objective or f"{action} {name}",
        }
        if hasattr(template, "object_id") and not getattr(template, "object_id", None):
            updates["object_id"] = name
        return template.model_copy(update=updates)

    def _queue_event_task(self, task) -> None:
        if self.plan is None:
            return
        if self.status == "complete" or self.current_task_index < 0 or self.current_task_index >= len(self.plan.tasks):
            self.plan.tasks.append(task)
            self.task_status[task.id] = TaskStatus.active.value
            self.current_task_index = len(self.plan.tasks) - 1
            self.task_started_at = self.world.sim_time
            self.runtime = activate_task(task, self.world, self.plan)
            self.status = "running"
            return
        index = self._event_insert_index()
        self.plan.tasks.insert(index, task)
        self.task_status[task.id] = TaskStatus.pending.value

    def _maybe_on_event(self, contacts: list[dict], when: str = "Detected") -> set[str]:
        handled: set[str] = set()
        if self.status == "planning" or self.plan is None or not contacts:
            return handled
        rules = [r for r in self.plan.on_event if r.when == when]
        if not rules:
            return handled
        for contact in contacts:
            object_type = str(contact.get("object_type", "")).lower()
            name = str(contact.get("name") or "")
            if not name:
                continue
            rule = next((r for r in rules if r.object_type.lower() == object_type), None)
            if rule is None:
                continue
            handled.add(name)
            if self._already_has_object_task(name, object_type):
                continue
            bound = self._bind_event_task(rule.then, contact)
            if getattr(bound, "object_id", None):
                self.world.space.note_contact(bound.object_id, object_type)
            self._queue_event_task(bound)
            self.world.add_event(
                "on_event",
                when=when,
                action=action_key(bound),
                object=name,
                object_type=object_type,
                task_id=bound.id,
            )
        return handled

    def _contact_events(self) -> list[dict]:
        eyes = {
            agent.id: (
                float(agent.position[0]),
                float(agent.position[1]),
                float(agent.z_position or 0),
            )
            for agent in self.world.agents
        }
        events: list[dict] = []
        for obj in self.world.map_objects:
            if not obj.detected:
                continue
            name = obj.name
            object_type = str(obj.object_type).lower()
            observers = self.world.space.observers(obj, eyes)
            x, y = float(obj.position[0]), float(obj.position[1])
            if observers:
                self._unseen_counts[name] = 0
                if name in self._lost_names:
                    self._lost_names.discard(name)
                    events.append({"when": "Reacquired", "name": name, "object_type": object_type})
            else:
                self._unseen_counts[name] = self._unseen_counts.get(name, 0) + 1
                if name not in self._lost_names and self._unseen_counts[name] >= LOST_TICKS:
                    self._lost_names.add(name)
                    events.append({"when": "Lost", "name": name, "object_type": object_type})
            prev = self._moved_pose.get(name)
            if prev is None:
                self._moved_pose[name] = (x, y)
            else:
                dx = x - prev[0]
                dy = y - prev[1]
                if (dx * dx + dy * dy) ** 0.5 >= MOVE_THRESHOLD:
                    self._moved_pose[name] = (x, y)
                    events.append({"when": "Moved", "name": name, "object_type": object_type})
        return events

    def _fail_track_task(self, name: str) -> None:
        if not name or self.runtime.mode not in ("investigate", "follow"):
            return
        if self.runtime.object_id != name:
            return
        if self.plan is None or self.current_task_index < 0:
            return
        if self.current_task_index >= len(self.plan.tasks):
            return
        task = self.plan.tasks[self.current_task_index]
        self.task_status[task.id] = TaskStatus.fail.value
        self.world.add_event("task_fail", task_id=task.id, reason="lost")
        self._advance_task()

    def _maybe_replan(self, new_detections: list[dict]) -> None:
        if self.status == "planning":
            return
        if not self.mission_statement or self._planner_fn is None:
            return
        hits = [
            d for d in new_detections
            if str(d.get("object_type", "")).lower() in self.REPLAN_TYPES
        ]
        if not hits:
            return
        names = ", ".join(f"{d.get('name')} ({d.get('object_type')})" for d in hits)
        version = self.plan.version if self.plan else 0
        context = (
            f"New detections: {names}. Current plan version: {version}. "
            "Revise the current plan only if the operator mission requires it. "
            "Do not add Investigate of named landmarks."
        )
        self.request_mission(self.mission_statement, self._planner_fn, extra_context=context)

    def request_mission(self, statement: str, planner, extra_context: str | None = None) -> dict:
        compile_id = self._bump_compile_seq()
        self._planner_fn = planner
        self.mission_statement = statement
        self.last_error = None

        context = extra_context
        if extra_context:
            snapshot = self._plan_snapshot()
            if snapshot:
                context = f"{extra_context} Current plan: {json.dumps(snapshot)}."
        else:
            self._clear_groups()
            self._clear_published_plan()

        self.runtime = activate_task(None, self.world, self.plan)
        self.status = "planning"
        self.world.add_event("planning", mission=statement)
        self._rebuild_snapshot()

        async def _run():
            try:
                result = await planner(statement, self.world, context)
            except TypeError:
                result = await planner(statement, self.world)
            except asyncio.CancelledError:
                if compile_id == self._compile_seq:
                    self.status = "idle"
                raise
            if compile_id != self._compile_seq:
                return
            metrics = {
                "elapsed_ms": result.get("elapsed_ms"),
                "repairs": result.get("repairs"),
                "ok": bool(result.get("ok")),
                "model": result.get("model"),
            }
            self.world.add_event("plan_metrics", **{k: v for k, v in metrics.items() if v is not None})
            append_compile_log(statement, result)
            if not result.get("ok"):
                self.last_error = result.get("error") or "Planning failed"
                self.status = "idle"
                self.world.add_event("plan_error", error=self.last_error)
                self._rebuild_snapshot()
                return
            plan = result["plan"]
            ok, err = self.apply_plan(plan)
            if not ok:
                self.last_error = err
                self.status = "idle"
                self.world.add_event("plan_error", error=err)
                self._rebuild_snapshot()

        self._planner_task = asyncio.create_task(_run())
        return {"ok": True, "status": "Planning", "session_status": "planning"}
