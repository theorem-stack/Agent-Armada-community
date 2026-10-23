from api.geometry.kernel import SpatialKernel
from api.geometry.regions import Region
from api.session.world import WorldState, clone_map


def test_clone_map_start_detected_types():
    by_name = {obj.name: obj for obj in clone_map("hurricane_map")}
    assert by_name["Home1"].detected
    assert by_name["Home2"].detected
    assert by_name["Flooded Area"].detected
    assert by_name["Fallen Tree"].detected
    assert by_name["Shipping Container"].detected
    assert not by_name["Person1"].detected
    assert not by_name["Person2"].detected
    assert not by_name["Person3"].detected
    assert not by_name["Car"].detected


def test_car_region_is_centered_on_position():
    world = WorldState("hurricane_map")
    car = world.space.bind("Car")
    assert car is not None
    assert car.position == (700.0, 300.0)
    assert car.region.x1 < car.position[0] < car.region.x2
    assert car.region.y1 < car.position[1] < car.region.y2


def test_bind_person_and_miss():
    world = WorldState("hurricane_map")
    bound = world.space.bind("Person1")
    assert bound is not None
    assert bound.object_type == "person"
    assert bound.position == (50.0, 50.0)
    assert world.space.bind("Nobody") is None
    assert world.object_by_name("Person1") is not None


def test_nearest_person():
    world = WorldState("hurricane_map")
    hit = world.space.nearest((55, 55), object_type="person")
    assert hit is not None
    assert hit.name == "Person1"


def test_in_region_filters_type():
    world = WorldState("hurricane_map")
    region = Region(x1=0, y1=0, x2=80, y2=80)
    people = world.space.in_region(region, object_type="person")
    names = {b.name for b in people}
    assert names == {"Person1"}
    floods = world.space.in_region(region, object_type="flood")
    assert floods == []


def test_standoff_stays_in_bbox():
    world = WorldState("hurricane_map")
    point = world.space.standoff("Person1", world.space.center(), 30.0)
    assert point is not None
    x, y = point
    x1, y1, x2, y2 = world.bbox
    assert x1 <= x <= x2
    assert y1 <= y <= y2
    px, py = world.space.bind("Person1").position
    dist = ((x - px) ** 2 + (y - py) ** 2) ** 0.5
    assert 20 <= dist <= 40


def test_kernel_reindex_drops_removed_names():
    world = WorldState("hurricane_map")
    kept = [obj for obj in world.map_objects if obj.name != "Person1"]
    kernel = SpatialKernel(world.bbox, kept)
    assert kernel.bind("Person1") is None
    assert kernel.bind("Person2") is not None


def test_search_paint_reduces_uncovered_mass():
    from api.plan.ir import Plan, SearchTask
    from api.session.session import Session

    session = Session.create("hurricane_map")
    before = session.world.space.uncovered_mass()
    assert abs(before - 1.0) < 0.05
    ok, err = session.apply_plan(Plan(tasks=[SearchTask(id="s1")]))
    assert ok, err
    for _ in range(40):
        session.physics_tick()
    after = session.world.space.uncovered_mass()
    assert after < before
    assert session.world.coverage.fraction() > 0


def test_investigate_raises_local_occupancy():
    world = WorldState("hurricane_map")
    prior = world.space.probability_at((50, 50))
    assert prior is not None
    world.space.observe_occupied(50, 50)
    assert world.space.probability_at((50, 50)) > prior


def test_sector_graph_adjacency():
    world = WorldState("hurricane_map")
    sectors = world.space.sectors()
    assert len(sectors) == 4
    by_id = {s.id: s for s in sectors}
    assert set(by_id["0_0"].neighbors) == {"0_1", "1_0"}
    assert set(by_id["1_1"].neighbors) == {"1_0", "0_1"}
    uncovered = world.space.uncovered_sectors()
    assert {s.id for s in uncovered} == {s.id for s in sectors}


def test_nearest_ids_picks_k():
    world = WorldState("hurricane_map")
    poses = {
        0: (10.0, 10.0),
        1: (12.0, 10.0),
        2: (400.0, 300.0),
        3: (700.0, 500.0),
    }
    chosen = world.space.nearest_ids((11.0, 10.0), poses, 2)
    assert chosen == [0, 1] or set(chosen) == {0, 1}
    assert len(chosen) == 2


def test_assign_sectors_splits_two_sites():
    world = WorldState("hurricane_map")
    assigned = world.space.assign_sectors(
        {
            "west": (100.0, 300.0),
            "east": (700.0, 300.0),
        }
    )
    assert assigned["west"]
    assert assigned["east"]
    west_ids = {s.id for s in assigned["west"]}
    east_ids = {s.id for s in assigned["east"]}
    assert west_ids.isdisjoint(east_ids)
    assert west_ids | east_ids == {s.id for s in world.space.sectors()}


def test_reset_belief_restores_mass():
    world = WorldState("hurricane_map")
    world.space.observe_free(50, 50)
    assert world.space.uncovered_mass() < 1.0
    world.space.reset_belief()
    assert abs(world.space.uncovered_mass() - 1.0) < 0.05


def test_detected_and_undetected_counts():
    world = WorldState("hurricane_map")
    names = {b.name for b in world.space.detected()}
    assert names == {
        "Home1",
        "Home2",
        "Flooded Area",
        "Fallen Tree",
        "Shipping Container",
    }
    assert "Person1" not in names
    assert "Car" not in names
    counts = world.space.undetected_counts()
    assert counts.get("person") == 3
    assert counts.get("vehicle") == 1
    assert "building" not in counts
    assert "tree" not in counts
    person = world.space.object("Person1")
    person.detected = True
    found = {b.name for b in world.space.detected()}
    assert "Person1" in found
    assert world.space.undetected_counts().get("person") == 2


def test_resolve_object_uses_latest_detected_contact():
    world = WorldState("hurricane_map")
    assert world.space.latest_contact("person") is None
    world.space.note_contact("Person1", "person")
    bound = world.space.resolve_object(None, prefer_type="person")
    assert bound is not None
    assert bound.name == "Person1"
    typed = world.space.resolve_object("person")
    assert typed is not None
    assert typed.name == "Person1"
    world.space.note_contact("Person2", "person")
    assert world.space.resolve_object("last_contact").name == "Person2"
    assert world.space.resolve_object("person").name == "Person2"


def test_anchor_center_and_corners():
    world = WorldState("hurricane_map")
    x1, y1, x2, y2 = world.bbox
    center = world.space.anchor("bbox_center")
    assert center is not None
    assert center.position == world.space.center()
    assert world.space.anchor("sw_corner").position == (x1, y1)
    assert world.space.anchor("se_corner").position == (x2, y1)
    assert world.space.anchor("nw_corner").position == (x1, y2)
    assert world.space.anchor("ne_corner").position == (x2, y2)
    flood = world.space.anchor("Flooded Area")
    assert flood is not None
    assert flood.object_type == "flood"
    assert world.space.anchor("nowhere") is None


def test_visible_open_field_overhead():
    from api.simulation.mapObject import mapObject

    person = mapObject("P", [50, 50], ((40, 40), (60, 60)), "person")
    kernel = SpatialKernel([0, 0, 800, 600], [person])
    assert kernel.visible((50, 50, 50), person)
    assert kernel.visible((50, 50, 50), "P")


def test_visible_out_of_range():
    from api.config import SENSOR_RANGE
    from api.simulation.mapObject import mapObject

    person = mapObject("P", [50, 50], ((40, 40), (60, 60)), "person")
    kernel = SpatialKernel([0, 0, 800, 600], [person])
    assert not kernel.visible((50, 50 + SENSOR_RANGE + 20, 50), person)


def test_occluded_by_building_blocks_visible():
    from api.simulation.mapObject import mapObject

    person = mapObject("P", [50, 50], ((45, 45), (55, 55)), "person")
    building = mapObject("B", [50, 80], ((40, 65), (60, 95)), "building")
    kernel = SpatialKernel([0, 0, 800, 600], [person, building])
    eye = (50, 110, 20)
    assert kernel.occluded(eye, person)
    assert not kernel.visible(eye, person)


def test_container_occludes_from_the_side():
    from api.simulation.mapObject import mapObject

    person = mapObject("P", [50, 50], ((40, 40), (60, 60)), "person")
    box = mapObject("C", [50, 80], ((18, 68), (82, 92)), "container")
    kernel = SpatialKernel([0, 0, 800, 600], [person, box])
    assert kernel.occluded((50, 110, 8), person)
    assert not kernel.occluded((50, 50, 50), person)
    assert kernel.visible((50, 50, 50), person)


def test_overhead_ray_misses_offset_tree():
    from api.simulation.mapObject import mapObject

    person = mapObject("P", [50, 50], ((40, 40), (60, 60)), "person")
    tree = mapObject("T", [50, 72], ((38, 60), (62, 84)), "tree")
    kernel = SpatialKernel([0, 0, 800, 600], [person, tree])
    eye = (50, 50, 50)
    assert not kernel.occluded(eye, person)
    assert kernel.visible(eye, person)


def test_observers_and_fused_tracks():
    from api.simulation.mapObject import mapObject

    person = mapObject("P", [50, 50], ((40, 40), (60, 60)), "person")
    person.detected = True
    kernel = SpatialKernel([0, 0, 800, 600], [person])
    eyes = {3: (50, 50, 50), 7: (400, 400, 50)}
    assert kernel.observers(person, eyes) == [3]
    tracks = kernel.fused_tracks(eyes, tick=12)
    assert len(tracks) == 1
    assert tracks[0]["name"] == "P"
    assert tracks[0]["observers"] == [3]
    assert tracks[0]["last_seen_tick"] == 12
    assert 0 < tracks[0]["confidence"] <= 1
    assert tracks[0]["velocity"] == [0.0, 0.0]
    kernel.record_motion(1.0)
    person.apply_pose(60, 50)
    kernel.record_motion(1.0)
    tracks = kernel.fused_tracks(eyes, tick=13)
    assert tracks[0]["velocity"][0] > 0
    hidden = mapObject("Q", [200, 200], ((190, 190), (210, 210)), "person")
    kernel = SpatialKernel([0, 0, 800, 600], [person, hidden])
    assert kernel.fused_tracks(eyes, tick=1)[0]["name"] == "P"


def test_sector_uncovered_is_mass_only():
    world = WorldState("hurricane_map")
    before = world.space.sector_uncovered()
    assert set(before) == {s.id for s in world.space.sectors()}
    world.space.observe_free(50, 50)
    after = world.space.sector_uncovered()
    assert after["0_0"] < before["0_0"]
    for sid in ("0_1", "1_0", "1_1"):
        assert after[sid] == before[sid]
