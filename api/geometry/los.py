from __future__ import annotations

import math
from typing import Optional, Sequence

from ..config import OBJECT_HEIGHTS, SENSOR_HALF_ANGLE, SENSOR_RANGE

_EPS = 1e-9


def object_height(obj) -> float:
    key = str(getattr(obj, "object_type", "")).lower()
    return float(OBJECT_HEIGHTS.get(key, 2.0))


def object_aabb(obj) -> tuple[float, float, float, float, float, float]:
    box = getattr(obj, "boundingBox", None)
    if box is not None:
        (x1, y1), (x2, y2) = box
        minx, maxx = (float(x1), float(x2)) if x1 <= x2 else (float(x2), float(x1))
        miny, maxy = (float(y1), float(y2)) if y1 <= y2 else (float(y2), float(y1))
    else:
        pos = getattr(obj, "position", (0.0, 0.0))
        x, y = float(pos[0]), float(pos[1])
        minx = maxx = x
        miny = maxy = y
    height = object_height(obj)
    return minx, miny, 0.0, maxx, maxy, height


def eye_xyz(eye) -> tuple[float, float, float]:
    if hasattr(eye, "position"):
        pos = eye.position
        if hasattr(pos, "tolist"):
            pos = pos.tolist()
        z = getattr(eye, "z_position", None)
        if z is None:
            z = getattr(eye, "z", 0.0)
        return float(pos[0]), float(pos[1]), float(z or 0.0)
    if isinstance(eye, dict):
        pos = eye.get("position", (eye.get("x", 0.0), eye.get("y", 0.0)))
        if hasattr(pos, "tolist"):
            pos = pos.tolist()
        z = eye.get("z_position", eye.get("z", 0.0))
        return float(pos[0]), float(pos[1]), float(z or 0.0)
    vals = list(eye)
    if len(vals) >= 3:
        return float(vals[0]), float(vals[1]), float(vals[2])
    return float(vals[0]), float(vals[1]), 0.0


def target_xyz(obj) -> tuple[float, float, float]:
    pos = obj.position
    if hasattr(pos, "tolist"):
        pos = pos.tolist()
    return float(pos[0]), float(pos[1]), object_height(obj) * 0.5


def ray_aabb(
    origin: Sequence[float],
    direction: Sequence[float],
    aabb: Sequence[float],
    tmax: float,
) -> Optional[float]:
    """Slab test. `direction` must be unit length. Returns hit t or None."""
    ox, oy, oz = origin
    dx, dy, dz = direction
    minx, miny, minz, maxx, maxy, maxz = aabb
    tmin = 0.0
    hit_max = float(tmax)
    for o, d, lo, hi in (
        (ox, dx, minx, maxx),
        (oy, dy, miny, maxy),
        (oz, dz, minz, maxz),
    ):
        if abs(d) < _EPS:
            if o < lo or o > hi:
                return None
            continue
        inv = 1.0 / d
        t1 = (lo - o) * inv
        t2 = (hi - o) * inv
        if t1 > t2:
            t1, t2 = t2, t1
        tmin = max(tmin, t1)
        hit_max = min(hit_max, t2)
        if hit_max < tmin:
            return None
    return tmin


def in_downward_cone(
    eye: Sequence[float],
    target: Sequence[float],
    *,
    range_m: float = SENSOR_RANGE,
    half_angle_deg: float = SENSOR_HALF_ANGLE,
) -> bool:
    ex, ey, ez = eye
    tx, ty, tz = target
    dx, dy, dz = tx - ex, ty - ey, tz - ez
    dist = math.sqrt(dx * dx + dy * dy + dz * dz)
    if dist > range_m:
        return False
    if dist < _EPS:
        return True
    cos_nadir = -dz / dist
    return cos_nadir >= math.cos(math.radians(half_angle_deg))
