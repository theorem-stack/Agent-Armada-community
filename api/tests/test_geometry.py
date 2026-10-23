from api.config import ENV_HEIGHT, ENV_WIDTH, NUM_AGENTS
from api.geometry.generators import form_points, lawnmower, sample_circle
from api.geometry.regions import Region, point_in_region


def test_form_returns_n_points():
    region = [0, 0, ENV_WIDTH, ENV_HEIGHT]
    for shape in ("circle", "line", "perimeter", "grid", "square", "triangle"):
        pts = form_points(NUM_AGENTS, shape, region)
        assert len(pts) == NUM_AGENTS


def test_circle_points_in_env():
    pts = sample_circle(8, (400, 300), 80)
    assert len(pts) == 8
    for x, y in pts:
        assert 0 <= x <= ENV_WIDTH
        assert 0 <= y <= ENV_HEIGHT


def test_lawnmower_stays_in_region():
    region = Region(x1=100, y1=100, x2=300, y2=250)
    path = lawnmower(region, spacing=40)
    assert path
    for x, y in path:
        assert point_in_region((x, y), region, pad=1.0)
