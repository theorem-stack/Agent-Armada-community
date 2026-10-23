import asyncio
import time

from fastapi.testclient import TestClient

from api.config import LOST_TICKS
from api.plan.ir import EventRule, FollowTask, GoToTask, HoldTask, InvestigateTask, Plan
from api.planner.planner import fixture_plan
from api.session.session import Session


async def _fake_planner(statement, world, context=None, *, delay=0.0, plan=None):
    if delay:
        await asyncio.sleep(delay)
    return {
        "ok": True,
        "error": None,
        "plan": plan or fixture_plan(),
        "elapsed_ms": 11,
        "repairs": 0,
        "model": "fake",
    }


def test_mission_returns_before_plan_applied():
    async def body():
        started = asyncio.Event()
        released = asyncio.Event()

        async def fake(statement, world, context=None):
            started.set()
            await released.wait()
            return await _fake_planner(statement, world, context)

        session = Session.create("hurricane_map")
        result = session.request_mission("form a circle", fake)
        assert result["ok"] is True
        assert result["status"] == "Planning"
        assert session.plan is None
        await started.wait()
        assert session.plan is None
        released.set()
        await session._planner_task
        assert session.plan is not None
        assert any(e["type"] == "plan_metrics" for e in session.world.events)

    asyncio.run(body())


def _allocate_plan():
    return Plan.model_validate(
        {
            "tasks": [
                {
                    "id": "a1",
                    "action": "Allocate",
                    "groups": [
                        {"name": "alpha", "count": 10, "role": "search"},
                        {"name": "bravo", "count": 10, "role": "guard"},
                    ],
                }
            ]
        }
    )


def _search_on_event_plan():
    return Plan.model_validate(
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
        }
    )


def _undetect_only(session, *names):
    wanted = set(names)
    for obj in session.world.map_objects:
        obj.detected = obj.name not in wanted


def test_on_event_queues_investigate_without_replan():
    async def body():
        calls = []

        async def fake(statement, world, context=None):
            calls.append(context)
            return await _fake_planner(statement, world, context)

        session = Session.create("hurricane_map")
        ok, err = session.apply_plan(_search_on_event_plan())
        assert ok, err
        session.mission_statement = "search the area"
        session._planner_fn = fake
        _undetect_only(session, "Person1")
        person = next(obj for obj in session.world.map_objects if obj.name == "Person1")
        session.world.agents[0].position[:] = person.position
        session.assess_tick()
        assert session.status == "running"
        assert calls == []
        assert session.task_status["s1"] == "success"
        assert session.plan.tasks[1].id == "evt-Person1"
        assert session.plan.tasks[1].action == "Investigate"
        assert session.plan.tasks[1].object_id == "Person1"
        assert session.task_status["evt-Person1"] == "active"
        assert session.current_task_index == 1
        assert any(e["type"] == "on_event" for e in session.world.events)
        assert session.runtime.mode == "investigate"

    asyncio.run(body())


def test_on_event_dedupes_and_queues_second_person():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(_search_on_event_plan())
    assert ok, err
    p1 = next(obj for obj in session.world.map_objects if obj.name == "Person1")
    p2 = next(obj for obj in session.world.map_objects if obj.name == "Person2")
    _undetect_only(session, "Person1")
    session.world.agents[0].position[:] = p1.position
    session.assess_tick()
    _undetect_only(session, "Person1")
    session.assess_tick()
    evt_ids = [t.id for t in session.plan.tasks if str(t.id).startswith("evt-")]
    assert evt_ids == ["evt-Person1"]
    _undetect_only(session, "Person2")
    session.world.agents[0].position[:] = p2.position
    session.assess_tick()
    evt_ids = [t.id for t in session.plan.tasks if str(t.id).startswith("evt-")]
    assert evt_ids == ["evt-Person1", "evt-Person2"]
    assert session.plan.tasks[1].object_id == "Person1"
    assert session.plan.tasks[2].object_id == "Person2"


def test_on_event_activates_when_plan_complete():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(_search_on_event_plan())
    assert ok, err
    session.task_status["s1"] = "success"
    session.current_task_index = 1
    session.status = "complete"
    _undetect_only(session, "Person1")
    person = next(obj for obj in session.world.map_objects if obj.name == "Person1")
    session.world.agents[0].position[:] = person.position
    session.assess_tick()
    assert session.status == "running"
    assert session.plan.tasks[-1].id == "evt-Person1"
    assert session.runtime.mode == "investigate"


def _search_only_plan():
    return Plan.model_validate(
        {
            "tasks": [
                {"id": "s1", "action": "Search", "pattern": "lawnmower"},
            ],
        }
    )


def test_search_without_on_event_does_not_queue_investigate():
    session = Session.create("hurricane_map")
    ok, err = session.apply_plan(_search_only_plan())
    assert ok, err
    assert session.plan.on_event == []
    _undetect_only(session, "Person1")
    person = next(obj for obj in session.world.map_objects if obj.name == "Person1")
    session.world.agents[0].position[:] = person.position
    session.assess_tick()
    assert session.status == "complete"
    assert session.task_status["s1"] == "success"
    assert not any(t.action == "Investigate" for t in session.plan.tasks)


def test_person_detection_triggers_replan():
    async def body():
        contexts = []

        async def fake(statement, world, context=None):
            contexts.append(context)
            if context:
                plan = Plan(tasks=[GoToTask(id="g2", target="bbox_center")])
            else:
                plan = fixture_plan()
            return await _fake_planner(statement, world, context, plan=plan)

        session = Session.create("hurricane_map")
        session.request_mission("search the area", fake)
        await session._planner_task
        version = session.plan.version
        person = next(obj for obj in session.world.map_objects if obj.object_type == "person")
        person.detected = False
        session.world.agents[0].position[:] = person.position
        session.assess_tick()
        assert session.status == "planning"
        await session._planner_task
        assert session.plan.version == version + 1
        assert contexts[-1]
        assert "Person" in contexts[-1] or "person" in contexts[-1]
        assert "Current plan" in contexts[-1]
        assert "t1" in contexts[-1]

    asyncio.run(body())


def test_operator_submit_does_not_reuse_replan_context():
    async def body():
        contexts = []
        groups = []

        async def fake(statement, world, context=None):
            contexts.append(context)
            groups.append(dict(world.groups))
            return await _fake_planner(statement, world, context)

        session = Session.create("hurricane_map")
        ok, err = session.apply_plan(_allocate_plan())
        assert ok, err
        assert session.world.groups
        session.request_mission("search the area", fake)
        await session._planner_task
        assert contexts == [None]
        assert groups[-1] == {}
        assert session.plan is not None
        assert session.snapshot["plan"] is not None

        person = next(obj for obj in session.world.map_objects if obj.object_type == "person")
        person.detected = False
        session.world.agents[0].position[:] = person.position
        session.assess_tick()
        if session.status == "planning":
            await session._planner_task
        assert any(ctx for ctx in contexts)

        session.request_mission("form a circle", fake)
        await session._planner_task
        assert contexts[-1] is None
        assert groups[-1] == {}
        assert session.mission_statement == "form a circle"
        assert session.plan is not None

    asyncio.run(body())


def test_stale_compile_does_not_apply():
    async def body():
        plan_a = Plan(tasks=[GoToTask(id="old", target="bbox_center")])
        plan_b = Plan(tasks=[GoToTask(id="new", target="sw_corner")])
        started = asyncio.Event()

        async def slow(statement, world, context=None):
            started.set()
            await asyncio.sleep(0.2)
            return await _fake_planner(statement, world, context, plan=plan_a)

        async def fast(statement, world, context=None):
            return await _fake_planner(statement, world, context, plan=plan_b)

        session = Session.create("hurricane_map")
        session.request_mission("first mission", slow)
        await started.wait()
        session.request_mission("second mission", fast)
        await session._planner_task
        await asyncio.sleep(0.25)
        assert session.mission_statement == "second mission"
        assert session.plan.tasks[0].id == "new"
        assert session.status == "running"

    asyncio.run(body())


def test_abort_clears_planning_session():
    async def body():
        session = Session.create("hurricane_map")
        session.request_mission("search the area", _fake_planner)
        await session._planner_task
        assert session.mission_statement == "search the area"
        session.abort()
        assert session.mission_statement is None
        assert session._planner_fn is None
        assert session.plan is None
        assert session.world.groups == {}

    asyncio.run(body())


def test_http_mission_returns_immediately(monkeypatch):
    async def slow(statement, world, context=None):
        await asyncio.sleep(0.4)
        return await _fake_planner(statement, world, context)

    monkeypatch.setattr("api.index.plan_mission", slow)
    from api.index import app

    client = TestClient(app)
    created = client.post("/api/py/sessions", json={"map_name": "hurricane_map"})
    assert created.status_code == 200
    sid = created.json()["session_id"]
    t0 = time.monotonic()
    posted = client.post(
        f"/api/py/sessions/{sid}/mission",
        json={"user_mission_statement": "form a circle"},
    )
    elapsed = time.monotonic() - t0
    assert posted.status_code == 200
    body = posted.json()
    assert body["ok"] is True
    assert body["status"] == "Planning"
    assert elapsed < 0.25


def test_moved_queues_without_replan():
    async def body():
        calls = []

        async def fake(statement, world, context=None):
            calls.append(context)
            return await _fake_planner(statement, world, context)

        session = Session.create("hurricane_map")
        plan = Plan(
            tasks=[HoldTask(id="h1")],
            on_event=[
                EventRule(when="Moved", object_type="person", then=InvestigateTask()),
            ],
        )
        ok, err = session.apply_plan(plan)
        assert ok, err
        session.mission_statement = "hold"
        session._planner_fn = fake
        person = session.world.object_by_name("Person1")
        person.detected = True
        session.assess_tick()
        session.relocate_object("Person1", 200.0, 200.0)
        session.assess_tick()
        assert calls == []
        assert any(t.id == "evt-Person1" and t.action == "Investigate" for t in session.plan.tasks)
        assert any(e["type"] == "on_event" and e.get("when") == "Moved" for e in session.world.events)

    asyncio.run(body())


def test_lost_and_reacquired_queue_without_replan():
    async def body():
        calls = []

        async def fake(statement, world, context=None):
            calls.append(context)
            return await _fake_planner(statement, world, context)

        session = Session.create("hurricane_map")
        plan = Plan(
            tasks=[HoldTask(id="h1")],
            on_event=[
                EventRule(when="Lost", object_type="person", then=HoldTask()),
            ],
        )
        ok, err = session.apply_plan(plan)
        assert ok, err
        session.mission_statement = "hold"
        session._planner_fn = fake
        person = session.world.object_by_name("Person1")
        person.detected = True
        for agent in session.world.agents:
            agent.position[:] = [700.0, 500.0]
            agent.z_position = 50
        for _ in range(LOST_TICKS):
            session.assess_tick()
        assert calls == []
        assert any(e["type"] == "on_event" and e.get("when") == "Lost" for e in session.world.events)

        session = Session.create("hurricane_map")
        plan = Plan(
            tasks=[HoldTask(id="h1")],
            on_event=[
                EventRule(when="Reacquired", object_type="person", then=InvestigateTask()),
            ],
        )
        ok, err = session.apply_plan(plan)
        assert ok, err
        session.mission_statement = "hold"
        session._planner_fn = fake
        person = session.world.object_by_name("Person1")
        person.detected = True
        for agent in session.world.agents:
            agent.position[:] = [700.0, 500.0]
            agent.z_position = 50
        for _ in range(LOST_TICKS):
            session.assess_tick()
        session.world.agents[0].position[:] = person.position
        session.assess_tick()
        assert calls == []
        assert any(e["type"] == "on_event" and e.get("when") == "Reacquired" for e in session.world.events)
        assert any(t.action == "Investigate" for t in session.plan.tasks)

    asyncio.run(body())
