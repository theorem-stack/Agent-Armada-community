from api.plan.skills import registry_prompt
from api.planner.planner import parse_and_validate
from api.planner.summary import compact_world_summary
from api.session.world import WorldState


def test_invalid_plan_json_rejected_without_exec():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate({"python_function": "exec('bad')", "tasks": []}, world)
    assert plan is None
    assert err
    assert "exec" not in err.lower() or "at least one task" in err.lower() or "schema" in err.lower() or "task" in err.lower()


def test_unsupported_mission():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {"unsupported": True, "error": "Cannot interrogate a suspect"},
        world,
    )
    assert plan is None
    assert "interrogat" in err.lower() or "unsupported" in err.lower()


def test_compact_world_summary_hides_undetected_names():
    world = WorldState("hurricane_map")
    summary = compact_world_summary(world)
    dumped = str(summary)
    assert "Person1" not in dumped
    assert "objects" not in summary
    assert summary["undetected_counts"].get("person") == 3
    detected_names = {item["name"] for item in summary["detected"]}
    assert "Person1" not in detected_names
    assert "Home1" not in detected_names
    place_names = {item["name"] for item in summary["places"]}
    assert "Flooded Area" in place_names
    assert "Home1" in place_names
    assert "Person1" not in place_names
    person = next(obj for obj in world.map_objects if obj.name == "Person1")
    person.detected = True
    summary = compact_world_summary(world)
    names = {item["name"] for item in summary["detected"]}
    assert "Person1" in names
    assert "Home1" not in names
    assert summary["undetected_counts"].get("person") == 2
    assert "uncovered_mass" in summary
    assert isinstance(summary["uncovered_mass"], float)
    assert "log_odds" not in summary
    assert "sectors" not in summary
    assert "sector_uncovered" not in summary
    assert "tracks" not in summary
    assert "observers" not in summary
    assert "velocity" not in summary
    assert "neighbors" not in summary
    assert "neighbors" not in str(summary)
    for item in summary["detected"]:
        assert "position" not in item
    world.space.observe_free(50, 50)
    later = compact_world_summary(world)
    assert later["uncovered_mass"] < summary["uncovered_mass"]
    assert "Person1" in str(later)  # already marked detected above
    assert "Person2" not in str(later)
    assert "Person3" not in str(later)
    assert "groups" not in summary
    assert "groups" not in later
    assert "velocity" not in later
    assert "tracks" not in later


def test_planner_prompt_has_no_geometry_graph():
    prompt = registry_prompt()
    lowered = prompt.lower()
    assert "sector" not in lowered
    assert "neighbor" not in lowered
    assert "uncovered_mass" not in lowered
    assert "occupancy" not in lowered
