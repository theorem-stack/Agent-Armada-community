from api.config import SEARCH_COVER_MIN
from api.plan.ir import GoToTask, SearchTask
from api.plan.predicates import eval_fail, eval_success
from api.plan.ir import PredicateCoverage, PredicateDetected, PredicateTimeout
from api.session.world import WorldState


def _paint_region(world, region) -> None:
    cs = world.coverage.cell_size
    c0 = max(0, int(region.x1 / cs))
    c1 = min(world.coverage.cols, int(region.x2 / cs) + 1)
    r0 = max(0, int(region.y1 / cs))
    r1 = min(world.coverage.rows, int(region.y2 / cs) + 1)
    world.coverage.visited[r0:r1, c0:c1] = True


def test_timeout_fail():
    world = WorldState("hurricane_map")
    world.sim_time = 25
    task = GoToTask(id="t1", target="bbox_center")
    assert eval_fail(PredicateTimeout(seconds=20), task, world, started_at=0) is True
    world.sim_time = 10
    assert eval_fail(PredicateTimeout(seconds=20), task, world, started_at=0) is False


def test_detected_predicate():
    world = WorldState("hurricane_map")
    task = SearchTask(id="t1")
    pred = PredicateDetected(object_type="person", min_count=1)
    assert eval_success(pred, task, world, [0], 0, {}) is False
    person = next(obj for obj in world.map_objects if obj.object_type == "person")
    person.detected = True
    assert eval_success(pred, task, world, [0], 0, {}) is True


def test_coverage_predicate():
    world = WorldState("hurricane_map")
    task = SearchTask(id="t1")
    world.coverage.visited[:] = True
    pred = PredicateCoverage(min=0.9)
    assert eval_success(pred, task, world, [0], 0, {}) is True
    world.coverage.reset()
    assert eval_success(pred, task, world, [0], 0, {}) is False


def test_search_default_ignores_start_detected_flood():
    world = WorldState("hurricane_map")
    flood = next(obj for obj in world.map_objects if obj.object_type == "flood")
    assert flood.detected
    task = SearchTask(id="s1", object_id="Flooded Area")
    assert eval_success(None, task, world, [0], 0, {}) is False


def test_search_default_succeeds_on_person_detection_during_task():
    world = WorldState("hurricane_map")
    task = SearchTask(id="s1")
    world.add_event("plan", version=1)
    world.add_event("detection", object="Person1", object_type="person")
    assert eval_success(None, task, world, [0], 0, {}) is True


def test_search_default_ignores_prior_person_detection():
    world = WorldState("hurricane_map")
    task = SearchTask(id="s1")
    world.add_event("detection", object="Person1", object_type="person")
    world.sim_time = 5.0
    world.add_event("plan", version=2)
    assert eval_success(None, task, world, [0], started_at=5.0, setpoints={}) is False


def test_search_default_succeeds_on_vehicle_detection_during_task():
    world = WorldState("hurricane_map")
    task = SearchTask(id="s1")
    world.add_event("plan", version=1)
    world.add_event("detection", object="Car", object_type="vehicle")
    assert eval_success(None, task, world, [0], 0, {}) is True


def test_search_for_vehicle_ignores_person_find():
    world = WorldState("hurricane_map")
    task = SearchTask(id="s1", object_id="vehicle")
    world.add_event("plan", version=1)
    world.add_event("detection", object="Person1", object_type="person")
    assert eval_success(None, task, world, [0], 0, {}) is False
    world.add_event("detection", object="Car", object_type="vehicle")
    assert eval_success(None, task, world, [0], 0, {}) is True


def test_search_default_succeeds_on_region_coverage():
    world = WorldState("hurricane_map")
    flood = world.space.anchor("Flooded Area")
    _paint_region(world, flood.region)
    assert world.coverage.fraction(flood.region) >= SEARCH_COVER_MIN
    assert world.coverage.fraction() < SEARCH_COVER_MIN
    bound = SearchTask(id="s1", object_id="Flooded Area")
    open_search = SearchTask(id="s2")
    assert eval_success(None, bound, world, [0], 0, {}) is True
    assert eval_success(None, open_search, world, [0], 0, {}) is False


def test_search_default_map_paint_does_not_cover_flood():
    world = WorldState("hurricane_map")
    flood = world.space.anchor("Flooded Area")
    world.coverage.visited[:] = True
    cs = world.coverage.cell_size
    c0 = max(0, int(flood.region.x1 / cs))
    c1 = min(world.coverage.cols, int(flood.region.x2 / cs) + 1)
    r0 = max(0, int(flood.region.y1 / cs))
    r1 = min(world.coverage.rows, int(flood.region.y2 / cs) + 1)
    world.coverage.visited[r0:r1, c0:c1] = False
    assert world.coverage.fraction() >= 0.8
    task = SearchTask(id="s1", object_id="Flooded Area")
    assert eval_success(None, task, world, [0], 0, {}) is False


def test_search_timeout_fails_not_success():
    world = WorldState("hurricane_map")
    task = SearchTask(id="s1")
    world.sim_time = 60
    assert eval_success(None, task, world, [0], 0, {}) is False
    assert eval_fail(None, task, world, started_at=0) is True


def test_agents_arrive_at_setpoints():
    world = WorldState("hurricane_map")
    task = GoToTask(id="t1", target="bbox_center")
    assigned = [a.id for a in world.agents]
    here = {a.id: (float(a.position[0]), float(a.position[1])) for a in world.agents}
    assert eval_success(None, task, world, assigned, 0, here) is True
    for a in world.agents:
        a.position[0] = 400
        a.position[1] = 300
    far = {a.id: (0.0, 0.0) for a in world.agents}
    assert eval_success(None, task, world, assigned, 0, far) is False
