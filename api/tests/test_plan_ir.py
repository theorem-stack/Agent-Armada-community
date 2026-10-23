from api.plan.ir import EventRule, FollowTask, FormTask, GoToTask, HoldTask, InvestigateTask, Plan, SearchTask
from api.plan.validate import validate_plan
from api.planner.planner import fixture_plan, parse_and_validate
from api.session.world import WorldState


def test_fixture_plan_validates():
    world = WorldState("hurricane_map")
    plan = fixture_plan()
    ok, err = validate_plan(plan, world)
    assert ok, err


def test_unknown_action_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "t1", "action": "Teleport"},
            ]
        },
        world,
    )
    assert plan is None
    assert err


def test_extra_param_field_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "t1", "action": "GoTo", "target": "bbox_center", "zoom": 12},
            ]
        },
        world,
    )
    assert plan is None
    assert err


def test_null_cross_skill_fields_stripped():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "plan": {
                "tasks": [
                    {
                        "id": "t1",
                        "action": "GoTo",
                        "target": "bbox_center",
                        "standoff": None,
                        "shape": None,
                        "pattern": None,
                    }
                ]
            }
        },
        world,
    )
    assert err is None, err
    assert plan is not None
    assert plan.tasks[0].action == "GoTo"


def test_success_stripped_then_valid():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {
                    "id": "t1",
                    "action": "GoTo",
                    "target": "bbox_center",
                    "success": {"type": "Timeout", "seconds": 3},
                }
            ]
        },
        world,
    )
    assert err is None
    assert plan is not None
    assert not hasattr(plan.tasks[0], "success") or getattr(plan.tasks[0], "success", None) is None


def test_goto_poses_rejected():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {
                    "id": "t1",
                    "action": "GoTo",
                    "poses": [[10, 10]],
                }
            ]
        },
        world,
    )
    assert plan is None
    assert err


def test_empty_agent_ids_rejected():
    world = WorldState("hurricane_map")
    plan = Plan.model_validate(
        {
            "tasks": [
                {"id": "t1", "action": "GoTo", "agent_ids": [], "target": "bbox_center"}
            ]
        }
    )
    ok, err = validate_plan(plan, world)
    assert not ok
    assert "empty" in err.lower()


def test_typed_goto_form_investigate():
    world = WorldState("hurricane_map")
    plan = Plan(tasks=[
        GoToTask(id="g", target="bbox_center"),
        FormTask(id="f", shape="circle"),
        InvestigateTask(id="i", object_id="Person1"),
    ])
    ok, err = validate_plan(plan, world)
    assert ok, err


def test_default_assignment_all_agents():
    world = WorldState("hurricane_map")
    plan = fixture_plan()
    ok, err = validate_plan(plan, world)
    assert ok, err
    from api.plan.handlers import resolve_agents

    agents = resolve_agents(plan.tasks[0], world)
    assert len(agents) == len(world.agents)


def test_on_event_investigate_template_parses():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search", "pattern": "lawnmower"},
            ],
            "on_event": [
                {
                    "when": "Detected",
                    "object_type": "person",
                    "then": {"action": "Investigate"},
                }
            ],
        },
        world,
    )
    assert err is None, err
    assert plan is not None
    assert plan.on_event[0].then.action == "Investigate"
    assert plan.on_event[0].then.object_id is None


def test_investigate_without_object_id_defers_to_runtime():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "i1", "action": "Investigate"},
            ]
        },
        world,
    )
    assert err is None, err
    assert plan is not None
    assert plan.tasks[0].object_id is None


def _schema_action(branch: dict):
    action = (branch.get("properties") or {}).get("action") or {}
    if "const" in action:
        return action["const"]
    if "enum" in action:
        return action["enum"][0]
    return None


def test_planner_schema_per_action_anyof():
    from api.plan.skills import SKILLS, planner_response_schema

    schema = planner_response_schema()
    plan_branch = schema["properties"]["plan"]["anyOf"][0]
    items = plan_branch["properties"]["tasks"]["items"]
    branches = items["anyOf"]
    assert len(branches) == len(SKILLS)
    names = {_schema_action(b) for b in branches}
    assert names == {s.name for s in SKILLS}
    goto = next(b for b in branches if _schema_action(b) == "GoTo")
    assert "standoff" not in goto.get("properties", {})
    assert "x" not in goto.get("properties", {})
    assert "y" not in goto.get("properties", {})
    assert "poses" not in goto.get("properties", {})
    search = next(b for b in branches if _schema_action(b) == "Search")
    assert "region" not in search.get("properties", {})
    form = next(b for b in branches if _schema_action(b) == "Form")
    assert "center" not in form.get("properties", {})
    assert "region" not in form.get("properties", {})
    then = plan_branch["properties"]["on_event"]["items"]["properties"]["then"]
    assert len(then["anyOf"]) == len(SKILLS)


def test_search_plan_has_no_injected_on_event():
    plan = Plan(tasks=[SearchTask(id="s1")])
    assert plan.on_event == []


def test_explicit_on_event_is_kept():
    plan = Plan(
        tasks=[SearchTask(id="s1")],
        on_event=[
            EventRule(
                when="Detected",
                object_type="person",
                then=HoldTask(id="h"),
            )
        ],
    )
    assert len(plan.on_event) == 1
    assert plan.on_event[0].then.action == "Hold"


def test_parse_search_without_on_event_stays_empty():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search", "pattern": "lawnmower"},
            ]
        },
        world,
    )
    assert err is None, err
    assert plan is not None
    assert plan.on_event == []


def test_on_event_follow_and_lost_templates_parse():
    world = WorldState("hurricane_map")
    plan, err = parse_and_validate(
        {
            "tasks": [{"id": "s1", "action": "Search"}],
            "on_event": [
                {
                    "when": "Detected",
                    "object_type": "vehicle",
                    "then": {"action": "Follow"},
                },
                {
                    "when": "Lost",
                    "object_type": "person",
                    "then": {"action": "Hold"},
                },
            ],
        },
        world,
    )
    assert err is None, err
    assert plan is not None
    assert any(r.when == "Lost" and r.then.action == "Hold" for r in plan.on_event)
    assert any(
        r.when == "Detected" and r.object_type == "vehicle" and r.then.action == "Follow"
        for r in plan.on_event
    )

