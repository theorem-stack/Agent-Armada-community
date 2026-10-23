import json

from api.plan.ir import FollowTask, FormTask, GoToTask, HoldTask, Plan, SearchTask
from api.plan.validate import validate_plan
from api.planner.compile_log import append_compile_log, compile_record
from api.planner.planner import parse_and_validate
from api.session.session import Session
from api.session.world import WorldState


def test_search_the_area():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "s1", "action": "Search", "pattern": "lawnmower"}]},
        world,
    )
    assert err is None, err
    assert isinstance(plan.tasks[0], SearchTask)
    assert plan.tasks[0].object_id is None
    assert plan.tasks[0].target is None
    assert plan.on_event == []


def test_search_the_flooded_area():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {
                    "id": "s1",
                    "action": "Search",
                    "pattern": "lawnmower",
                    "object_id": "Flooded Area",
                }
            ]
        },
        world,
    )
    assert err is None, err
    assert plan.tasks[0].object_id == "Flooded Area"


def test_find_people():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search"},
                {"id": "i1", "action": "Investigate"},
            ]
        },
        world,
    )
    assert err is None, err
    assert isinstance(plan.tasks[0], SearchTask)
    assert plan.tasks[1].action == "Investigate"
    assert plan.tasks[1].object_id is None
    assert plan.on_event == []


def test_go_to_map_center():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "g1", "action": "GoTo", "target": "bbox_center"}]},
        world,
    )
    assert err is None, err
    assert isinstance(plan.tasks[0], GoToTask)
    assert plan.tasks[0].target == "bbox_center"


def test_form_a_circle():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "f1", "action": "Form", "shape": "circle"}]},
        world,
    )
    assert err is None, err
    assert isinstance(plan.tasks[0], FormTask)
    assert plan.tasks[0].shape == "circle"


def test_hold():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "h1", "action": "Hold"}]},
        world,
    )
    assert err is None, err
    assert isinstance(plan.tasks[0], HoldTask)


def test_interrogate_unsupported():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"unsupported": True, "error": "Cannot interrogate a suspect"},
        world,
    )
    assert plan is None
    assert "interrogat" in err.lower() or "unsupported" in err.lower()


def test_form_s_unsupported():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"unsupported": True, "error": "Form shape S is not in the catalog"},
        world,
    )
    assert plan is None
    assert err


def test_goto_xy_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "g1", "action": "GoTo", "x": 10, "y": 20}]},
        world,
    )
    assert plan is None
    assert err


def test_goto_poses_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "g1", "action": "GoTo", "poses": [[10, 20]]}]},
        world,
    )
    assert plan is None
    assert err


def test_search_numeric_region_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {
                    "id": "s1",
                    "action": "Search",
                    "region": {"x1": 0, "y1": 0, "x2": 200, "y2": 200},
                }
            ]
        },
        world,
    )
    assert plan is None
    assert err


def test_unknown_object_id_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "s1", "action": "Search", "object_id": "Nobody"}]},
        world,
    )
    assert plan is None
    assert "unknown" in err.lower()


def test_search_flood_paths_stay_in_region():
    session = Session.create("hurricane_map")
    flood = session.world.space.bind("Flooded Area")
    assert flood is not None
    ok, err = session.apply_plan(Plan(tasks=[SearchTask(id="s1", object_id="Flooded Area")]))
    assert ok, err
    assert session.runtime.paths
    rg = flood.region
    for path in session.runtime.paths.values():
        for x, y in path:
            assert rg.x1 - 1.0 <= x <= rg.x2 + 1.0
            assert rg.y1 - 1.0 <= y <= rg.y2 + 1.0
    bbox = session.world.bbox
    xs = [p[0] for path in session.runtime.paths.values() for p in path]
    assert max(xs) < bbox[2] - 50


def test_validate_search_flood():
    world = WorldState("hurricane_map")
    ok, err = validate_plan(Plan(tasks=[SearchTask(id="s1", object_id="Flooded Area")]), world)
    assert ok, err


def test_compile_log_writes_symbols_only(tmp_path):
    plan = Plan(tasks=[SearchTask(id="s1", object_id="Flooded Area")])
    result = {
        "ok": True,
        "repairs": 0,
        "error": None,
        "model": "gpt-4o-mini",
        "plan": plan,
    }
    path = tmp_path / "compile.jsonl"
    append_compile_log("search the flooded area", result, path)
    record = json.loads(path.read_text().strip())
    assert record["statement"] == "search the flooded area"
    assert record["ok"] is True
    assert record["repairs"] == 0
    assert record["tasks"] == [
        {"action": "Search", "object_id": "Flooded Area", "pattern": "lawnmower"}
    ]
    dumped = str(compile_record("search the flooded area", result))
    assert "350" not in dumped
    assert "Person1" not in dumped


def test_compile_log_skips_fake_default_path(tmp_path, monkeypatch):
    from api.planner import compile_log as compile_log_mod

    monkeypatch.setattr(compile_log_mod, "LOG_PATH", tmp_path / "compile.jsonl")
    compile_log_mod.append_compile_log(
        "search the area",
        {"ok": True, "repairs": 0, "error": None, "model": "fake", "plan": Plan(tasks=[SearchTask(id="s1")])},
    )
    assert not (tmp_path / "compile.jsonl").exists()


def test_compile_log_records_on_event():
    plan = Plan.model_validate(
        {
            "tasks": [{"id": "s1", "action": "Search"}],
            "on_event": [{"when": "Detected", "object_type": "person", "then": {"action": "Investigate"}}],
        }
    )
    record = compile_record("search", {"ok": True, "plan": plan, "repairs": 0, "model": "gpt-4o-mini"})
    assert record["on_event"] == [{"when": "Detected", "object_type": "person", "then": "Investigate"}]


def test_search_bbox_center_is_omitted():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "s1", "action": "Search", "target": "bbox_center"}]},
        world,
    )
    assert err is None, err
    assert plan.tasks[0].target is None


def test_investigate_landmark_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "i1", "action": "Investigate", "object_id": "Home1"}]},
        world,
    )
    assert plan is None
    assert "person or vehicle" in err.lower()


def test_detected_syntax_object_id_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "i1", "action": "Investigate", "object_id": "Detected(person)"}]},
        world,
    )
    assert plan is None
    assert "name or type" in err.lower()


def test_search_then_named_hidden_person_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search"},
                {"id": "i1", "action": "Investigate", "object_id": "Person1"},
            ]
        },
        world,
    )
    assert plan is None
    assert "person" in err.lower()


def test_follow_named_contact():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "f1", "action": "Follow", "object_id": "Person1"}]},
        world,
    )
    assert err is None, err
    assert isinstance(plan.tasks[0], FollowTask)
    assert plan.tasks[0].object_id == "Person1"


def test_follow_unknown_unsupported():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "f1", "action": "Follow", "object_id": "Nobody"}]},
        world,
    )
    assert plan is None
    assert err
    assert "unknown" in err.lower()


def test_follow_requires_object_id():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"tasks": [{"id": "f1", "action": "Follow"}]},
        world,
    )
    assert err is None, err
    assert plan is not None
    assert plan.tasks[0].object_id is None


def test_search_then_investigate_omits_name():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search"},
                {"id": "i1", "action": "Investigate"},
            ]
        },
        world,
    )
    assert err is None, err
    assert plan.tasks[1].object_id is None


def test_search_then_form_vehicle_omits_undetected_name():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search", "object_id": "vehicle"},
                {"id": "f1", "action": "Form", "shape": "circle", "object_id": "vehicle"},
            ]
        },
        world,
    )
    assert err is None, err
    assert plan.tasks[0].object_id == "vehicle"
    assert plan.tasks[1].object_id == "vehicle"
    assert plan.tasks[1].shape == "circle"
