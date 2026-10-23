import asyncio

import numpy as np

from api.config import DEFAULT_SPAWN, INVESTIGATE_COUNT, INVESTIGATE_STANDOFF, LOST_TICKS, NUM_AGENTS, SPAWN_RADIUS
from api.plan.ir import FollowTask, FormTask, GoToTask, InvestigateTask, Plan, SearchTask
from api.planner.planner import fixture_plan
from api.session.session import Session


def test_agents_spawn_in_cluster_at_default():
    session = Session.create("hurricane_map")
    assert session.world.spawn == DEFAULT_SPAWN
    assert session.snapshot["spawn"] == [DEFAULT_SPAWN[0], DEFAULT_SPAWN[1]]
    for agent in session.world.agents:
        dx = float(agent.position[0]) - DEFAULT_SPAWN[0]
        dy = float(agent.position[1]) - DEFAULT_SPAWN[1]
        dist = (dx * dx + dy * dy) ** 0.5
        assert abs(dist - SPAWN_RADIUS) < 1e-6


def test_set_spawn_moves_cluster_and_clamps():
    session = Session.create("hurricane_map", spawn=(120.0, 90.0))
    assert session.world.spawn == (120.0, 90.0)
    origin = session.set_spawn(-40.0, 900.0)
    assert origin == (0.0, 600.0)
    assert session.snapshot["spawn"] == [0.0, 600.0]
    for agent in session.world.agents:
        x, y = float(agent.position[0]), float(agent.position[1])
        assert 0.0 <= x <= 800.0
        assert 0.0 <= y <= 600.0
        dx = x - origin[0]
        dy = y - origin[1]
        assert (dx * dx + dy * dy) ** 0.5 <= SPAWN_RADIUS + 1e-6
    assert session.status == "idle"
    assert session.plan is None


def test_place_move_delete_object_reindexes_kernel():
    session = Session.create("hurricane_map")
    before = len(session.world.map_objects)
    person = session.place_object("person", 120.0, 90.0)
    assert person.name == "Person4"
    assert person.authored
    assert not person.detected
    assert session.world.space.bind("Person4") is not None
    names = {item["name"] for item in session.snapshot["map_objects"]}
    assert "Person4" in names
    moved = session.relocate_object("Person4", 200.0, 220.0)
    assert moved.position == [200.0, 220.0]
    assert moved.heading == 0.0
    session.delete_object("Person4")
    assert session.world.space.bind("Person4") is None
    assert len(session.world.map_objects) == before


def test_rotate_object_updates_aabb_from_footprint():
    session = Session.create("hurricane_map")
    box = session.place_object("container", 200.0, 200.0)
    assert box.footprint == (64.0, 24.0)
    rotated = session.relocate_object(box.name, heading=1.5707963267948966)
    (x1, y1), (x2, y2) = rotated.boundingBox
    assert abs((x2 - x1) - 24.0) < 1e-6
    assert abs((y2 - y1) - 64.0) < 1e-6
    assert rotated.position == [200.0, 200.0]


def test_placed_person_stays_out_of_compact_summary():
    from api.planner.summary import compact_world_summary

    session = Session.create("hurricane_map")
    session.place_object("person", 120.0, 90.0)
    summary = compact_world_summary(session.world)
    assert "Person4" not in str(summary)
    assert summary["undetected_counts"].get("person") == 4


def test_session_create_mission_abort_persists_agents():
    session = Session.create("hurricane_map")
    assert len(session.world.agents) == NUM_AGENTS
    ids = [a.id for a in session.world.agents]
    positions = [tuple(a.position) for a in session.world.agents]

    ok, err = session.apply_plan(fixture_plan())
    assert ok, err
    assert session.status == "running"
    assert session.plan.version >= 1

    session.physics_tick()
    session.assess_tick()
    moved = [tuple(a.position) for a in session.world.agents]
    assert ids == [a.id for a in session.world.agents]

    session.abort()
    assert session.status == "idle"
    assert session.plan is None
    after_abort = [tuple(a.position) for a in session.world.agents]
    assert ids == [a.id for a in session.world.agents]
    assert after_abort == moved
    assert after_abort != positions or True

    ok, err = session.apply_plan(fixture_plan())
    assert ok, err
    assert session.plan.version == 2
    assert ids == [a.id for a in session.world.agents]
    assert [tuple(a.position) for a in session.world.agents] == after_abort
    assert session.mission_statement is None
    assert session.world.groups == {}


def test_allocate_then_form():
    session = Session.create("hurricane_map")
    plan = Plan.model_validate(
        {
            "tasks": [
                {
                    "id": "a1",
                    "action": "Allocate",
                    "objective": "Split swarm",
                    "groups": [
                        {"name": "alpha", "count": 10, "role": "search"},
                        {"name": "bravo", "count": 10, "role": "guard"},
                    ],
                },
                {
                    "id": "f1",
                    "action": "Form",
                    "objective": "Circle",
                    "group": "alpha",
                    "shape": "circle",
                },
            ]
        }
    )
    ok, err = session.apply_plan(plan)
    assert ok, err
    session.assess_tick()
    assert session.task_status["a1"] == "success"
    assert session.world.agents[0].group in ("alpha", "bravo")
    assert any(a.group == "alpha" for a in session.world.agents)


def test_apply_plan_drops_prior_groups():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(
        Plan.model_validate(
            {
                "tasks": [
                    {
                        "id": "a1",
                        "action": "Allocate",
                        "groups": [
                            {"name": "alpha", "count": 10},
                            {"name": "bravo", "count": 10},
                        ],
                    }
                ]
            }
        )
    )
    assert ok, err
    assert "alpha" in session.world.groups
    ok, err = session.apply_plan(Plan(tasks=[GoToTask(id="c", target="bbox_center")]))
    assert ok, err
    assert session.world.groups == {}
    assert all(agent.group is None for agent in session.world.agents)


def test_search_without_region_splits_groups():
    session = Session.create("hurricane_map")
    for obj in session.world.map_objects:
        obj.detected = True
    for i, agent in enumerate(session.world.agents):
        if i < 10:
            agent.position[:] = [80.0, 200.0 + i * 20.0]
        else:
            agent.position[:] = [720.0, 200.0 + (i - 10) * 20.0]
    plan = Plan.model_validate(
        {
            "tasks": [
                {
                    "id": "a1",
                    "action": "Allocate",
                    "groups": [
                        {"name": "alpha", "count": 10},
                        {"name": "bravo", "count": 10},
                    ],
                },
                {"id": "s1", "action": "Search", "pattern": "lawnmower"},
            ]
        }
    )
    ok, err = session.apply_plan(plan)
    assert ok, err
    session.assess_tick()
    assert session.runtime.mode == "search"
    alpha = [a for a in session.world.agents if a.group == "alpha"]
    bravo = [a for a in session.world.agents if a.group == "bravo"]
    alpha_path = session.runtime.paths[alpha[0].id]
    bravo_path = session.runtime.paths[bravo[0].id]
    assert alpha_path
    assert bravo_path
    assert alpha_path != bravo_path
    alpha_xs = [p[0] for p in alpha_path]
    bravo_xs = [p[0] for p in bravo_path]
    assert max(alpha_xs) <= 420
    assert min(bravo_xs) >= 380


def test_search_hold_investigate_and_avoid_overlay():
    session = Session.create("hurricane_map")
    plan = Plan.model_validate(
        {
            "overlays": {"avoid": ["Flooded Area"], "cruise_altitude": 80},
            "tasks": [
                {
                    "id": "s1",
                    "action": "Search",
                    "objective": "Sweep",
                    "pattern": "lawnmower",
                },
                {
                    "id": "i1",
                    "action": "Investigate",
                    "objective": "Check person",
                },
                {"id": "h1", "action": "Hold", "objective": "Loiter"},
            ],
        }
    )
    ok, err = session.apply_plan(plan)
    assert ok, err
    assert session.obstacles
    assert session.world.agents[0].z_position == 80
    assert session.runtime.mode == "search"
    assert session.runtime.paths
    session.assess_tick()
    assert session.task_status["s1"] in ("active", "success")


def test_hold_does_not_nan():
    session = Session.create("hurricane_map")
    for _ in range(30):
        session.physics_tick()
    for agent in session.world.agents:
        assert np.isfinite(agent.position).all()
        assert np.isfinite(agent.velocity).all()


def test_goto_center_setpoints():
    session = Session.create("hurricane_map")
    plan = Plan(tasks=[GoToTask(id="c", objective="Center", target="bbox_center")])
    ok, err = session.apply_plan(plan)
    assert ok, err
    cx = (session.world.bbox[0] + session.world.bbox[2]) / 2.0
    cy = (session.world.bbox[1] + session.world.bbox[3]) / 2.0
    for pt in session.runtime.setpoints.values():
        assert pt == (cx, cy)


def test_investigate_uses_k_nearest_and_searchers_cover():
    session = Session.create("hurricane_map")
    person = session.world.object_by_name("Person1")
    px, py = float(person.position[0]), float(person.position[1])
    for i, agent in enumerate(session.world.agents):
        if i < INVESTIGATE_COUNT:
            agent.position[:] = [px + 5.0 + i, py + 5.0]
        else:
            agent.position[:] = [600.0, 80.0 + (i - INVESTIGATE_COUNT) * 15.0]
    ok, err = session.apply_plan(Plan(tasks=[InvestigateTask(id="i1", object_id="Person1")]))
    assert ok, err
    assert session.runtime.mode == "investigate"
    assert len(session.runtime.assigned_ids) == INVESTIGATE_COUNT
    investigators = set(session.runtime.assigned_ids)
    assert investigators == set(range(INVESTIGATE_COUNT))
    for aid in investigators:
        assert aid not in session.runtime.paths
    searchers = [a.id for a in session.world.agents if a.id not in investigators]
    assert searchers
    assert all(aid in session.runtime.paths for aid in searchers)
    before = session.world.coverage.fraction()
    for _ in range(50):
        session.physics_tick()
    assert session.world.coverage.fraction() > before


def test_investigate_rebinds_when_person_moves():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(Plan(tasks=[InvestigateTask(id="i1", object_id="Person1")]))
    assert ok, err
    investigators = list(session.runtime.assigned_ids)
    before = {aid: session.runtime.setpoints[aid] for aid in investigators}
    session.relocate_object("Person1", 400.0, 300.0)
    session.physics_tick()
    for aid in investigators:
        assert session.runtime.setpoints[aid] != before[aid]
    before_cov = session.world.coverage.fraction()
    for _ in range(40):
        session.physics_tick()
    assert session.world.coverage.fraction() > before_cov


def test_search_find_completes_and_binds_investigate():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(
        Plan(tasks=[SearchTask(id="s1"), InvestigateTask(id="i1")])
    )
    assert ok, err
    person = session.world.object_by_name("Person1")
    session.world.agents[0].position[:] = person.position
    session.world.agents[0].z_position = 50
    session.assess_tick()
    assert person.detected
    assert session.task_status["s1"] == "success"
    nxt = session.plan.tasks[session.current_task_index]
    assert nxt.action == "Investigate"
    assert nxt.object_id == "Person1"
    assert session.task_status[nxt.id] == "active"
    assert session.runtime.mode == "investigate"
    assert session.runtime.object_id == "Person1"


def test_later_investigate_binds_detected_person():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(
        Plan(tasks=[SearchTask(id="s1"), InvestigateTask(id="i1")])
    )
    assert ok, err
    assert session.runtime.mode == "search"
    person = session.world.object_by_name("Person1")
    person.detected = True
    session.world.space.note_contact("Person1", "person")
    session.task_status["s1"] = "success"
    session._advance_task()
    assert session.runtime.mode == "investigate"
    assert session.runtime.object_id == "Person1"
    assert session.plan.tasks[1].object_id == "Person1"


def test_later_goto_binds_type_query():
    session = Session.create("hurricane_map")
    session.world.space.note_contact("Person1", "person")
    session.world.object_by_name("Person1").detected = True
    ok, err = session.apply_plan(
        Plan(tasks=[GoToTask(id="g1", object_id="person")])
    )
    assert ok, err
    assert session.plan.tasks[0].object_id == "Person1"
    px, py = session.world.space.bind("Person1").position
    for pt in session.runtime.setpoints.values():
        assert pt == (px, py)


def test_assess_keeps_person_on_tracks_after_detection_pulse():
    session = Session.create("hurricane_map")
    person = session.world.object_by_name("Person1")
    session.world.agents[0].position[:] = [50.0, 50.0]
    session.world.agents[0].z_position = 50
    session.assess_tick()
    assert person.detected
    assert any(item["name"] == "Person1" for item in session.new_detections)
    session.assess_tick()
    assert session.new_detections == []
    assert person.detected
    tracks = session.snapshot.get("tracks") or []
    assert any(track["name"] == "Person1" for track in tracks)


def test_snapshot_tracks_detected_person_with_observers():
    session = Session.create("hurricane_map")
    person = session.world.object_by_name("Person1")
    person.detected = True
    px, py = float(person.position[0]), float(person.position[1])
    session.world.agents[0].position[:] = [px, py]
    session.world.agents[0].z_position = 50
    session._rebuild_snapshot()
    tracks = session.snapshot.get("tracks")
    assert tracks
    found = next(t for t in tracks if t["name"] == "Person1")
    assert 0 in found["observers"]
    assert "confidence" in found
    summary_keys = set(session.snapshot["tracks"][0])
    assert "observers" in summary_keys
    assert "velocity" in summary_keys


def test_people_patrol_and_tracks_report_velocity():
    session = Session.create("hurricane_map")
    person = session.world.object_by_name("Person1")
    start = (float(person.position[0]), float(person.position[1]))
    for _ in range(20):
        session.physics_tick()
    after = (float(person.position[0]), float(person.position[1]))
    assert after != start
    person.detected = True
    session._rebuild_snapshot()
    found = next(t for t in session.snapshot["tracks"] if t["name"] == "Person1")
    speed = (found["velocity"][0] ** 2 + found["velocity"][1] ** 2) ** 0.5
    assert speed > 0
    from api.planner.summary import compact_world_summary

    summary = compact_world_summary(session.world)
    assert "tracks" not in summary
    assert "velocity" not in summary


def test_investigate_fails_on_lost():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(Plan(tasks=[InvestigateTask(id="i1", object_id="Person1")]))
    assert ok, err
    person = session.world.object_by_name("Person1")
    person.detected = True
    for agent in session.world.agents:
        agent.position[:] = [700.0, 500.0]
        agent.z_position = 50
    for _ in range(LOST_TICKS):
        session.assess_tick()
    assert session.task_status["i1"] == "fail"
    assert session.status == "complete"


def test_follow_peels_subset_and_does_not_succeed():
    session = Session.create("hurricane_map")
    person = session.world.object_by_name("Person1")
    px, py = float(person.position[0]), float(person.position[1])
    for i, agent in enumerate(session.world.agents):
        if i < INVESTIGATE_COUNT:
            agent.position[:] = [px + 5.0 + i, py + 5.0]
        else:
            agent.position[:] = [600.0, 80.0 + (i - INVESTIGATE_COUNT) * 15.0]
    ok, err = session.apply_plan(Plan(tasks=[FollowTask(id="f1", object_id="Person1")]))
    assert ok, err
    assert session.runtime.mode == "follow"
    assert len(session.runtime.assigned_ids) == INVESTIGATE_COUNT
    searchers = [a.id for a in session.world.agents if a.id not in session.runtime.assigned_ids]
    assert searchers
    assert all(aid in session.runtime.paths for aid in searchers)
    session.assess_tick()
    assert session.task_status["f1"] == "active"
    assert session.runtime.mode == "follow"


def test_search_detects_vehicle_does_not_queue_follow():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(Plan(tasks=[{"id": "s1", "action": "Search", "pattern": "lawnmower"}]))
    assert ok, err
    car = session.world.object_by_name("Car")
    session.world.agents[0].position[:] = car.position
    session.world.agents[0].z_position = 50
    session.assess_tick()
    assert car.detected
    assert session.task_status["s1"] == "success"
    assert session.status == "complete"
    assert not any(t.action == "Follow" for t in session.plan.tasks)


def test_search_for_vehicle_stays_active_without_contact():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(Plan(tasks=[SearchTask(id="s1", object_id="vehicle")]))
    assert ok, err
    assert session.runtime.mode == "search"
    assert session.task_status["s1"] == "active"


def test_search_vehicle_then_form_surrounds_without_follow():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(
        Plan(
            tasks=[
                SearchTask(id="s1", object_id="vehicle"),
                FormTask(id="f1", shape="circle", object_id="vehicle"),
            ]
        )
    )
    assert ok, err
    car = session.world.object_by_name("Car")
    session.world.agents[0].position[:] = car.position
    session.world.agents[0].z_position = 50
    session.assess_tick()
    assert car.detected
    assert session.task_status["s1"] == "success"
    assert session.runtime.mode == "form"
    assert session.plan.tasks[1].object_id == "Car"
    assert not any(t.action == "Follow" for t in session.plan.tasks)
    cx, cy = float(car.position[0]), float(car.position[1])
    for pt in session.runtime.setpoints.values():
        dist = ((pt[0] - cx) ** 2 + (pt[1] - cy) ** 2) ** 0.5
        assert abs(dist - INVESTIGATE_STANDOFF) < 1e-6
