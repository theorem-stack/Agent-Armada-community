from api.simulation.mapObject import mapObject


def test_map_object_schema_includes_radius_and_lowercase_type():
    obj = mapObject(
        "Home1",
        [100, 150],
        ((90, 140), (110, 160)),
        "Building",
        condition="damaged",
    )
    data = obj.convert_to_dict()

    assert data["object_type"] == "building"
    assert data["radius"] == 10.0  # max(20, 20) / 2
    assert data["boundingBox"] == [[90.0, 140.0], [110.0, 160.0]]
    assert data["position"] == [100, 150]
    assert "detected" in data
    assert data["authored"] is False
    assert data["name"] == "Home1"
    assert data["heading"] == 0.0
    assert data["footprint"] == [20.0, 20.0]
