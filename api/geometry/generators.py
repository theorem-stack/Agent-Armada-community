from __future__ import annotations

import math
from typing import Sequence

from .regions import Region, bbox_region


def _as_region(region_or_bbox) -> Region:
    if isinstance(region_or_bbox, Region):
        return region_or_bbox
    return bbox_region(region_or_bbox)


def sample_circle(n: int, center: Sequence[float], radius: float) -> list[tuple[float, float]]:
    if n <= 0:
        return []
    cx, cy = float(center[0]), float(center[1])
    r = max(float(radius), 1.0)
    return [
        (cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n))
        for i in range(n)
    ]


def sample_line(n: int, region: Region | Sequence[float], axis: str = "x") -> list[tuple[float, float]]:
    if n <= 0:
        return []
    rg = _as_region(region)
    if n == 1:
        return [rg.center]
    if axis == "y":
        x = (rg.x1 + rg.x2) / 2.0
        return [(x, rg.y1 + i * (rg.height / (n - 1))) for i in range(n)]
    y = (rg.y1 + rg.y2) / 2.0
    return [(rg.x1 + i * (rg.width / (n - 1)), y) for i in range(n)]


def sample_perimeter(n: int, region: Region | Sequence[float]) -> list[tuple[float, float]]:
    if n <= 0:
        return []
    rg = _as_region(region)
    peri = 2 * (rg.width + rg.height)
    if peri <= 0:
        return [rg.center] * n
    coords = []
    for i in range(n):
        d = (peri * i / n) % peri
        if d <= rg.width:
            coords.append((rg.x1 + d, rg.y1))
        elif d <= rg.width + rg.height:
            coords.append((rg.x2, rg.y1 + (d - rg.width)))
        elif d <= 2 * rg.width + rg.height:
            coords.append((rg.x2 - (d - rg.width - rg.height), rg.y2))
        else:
            coords.append((rg.x1, rg.y2 - (d - 2 * rg.width - rg.height)))
    return coords


def sample_grid(n: int, region: Region | Sequence[float]) -> list[tuple[float, float]]:
    if n <= 0:
        return []
    rg = _as_region(region)
    cols = max(1, math.ceil(math.sqrt(n)))
    rows = max(1, math.ceil(n / cols))
    xs = [rg.center[0]] if cols == 1 else [rg.x1 + (c + 0.5) * (rg.width / cols) for c in range(cols)]
    ys = [rg.center[1]] if rows == 1 else [rg.y1 + (r + 0.5) * (rg.height / rows) for r in range(rows)]
    points = [(xs[i % cols], ys[i // cols]) for i in range(n)]
    return points


def sample_square(n: int, center: Sequence[float], side: float) -> list[tuple[float, float]]:
    cx, cy = float(center[0]), float(center[1])
    h = max(float(side), 1.0) / 2.0
    region = Region(x1=cx - h, y1=cy - h, x2=cx + h, y2=cy + h)
    return sample_perimeter(n, region)


def sample_triangle(n: int, region: Region | Sequence[float]) -> list[tuple[float, float]]:
    if n <= 0:
        return []
    rg = _as_region(region)
    verts = [
        ((rg.x1 + rg.x2) / 2.0, rg.y1),
        (rg.x1, rg.y2),
        (rg.x2, rg.y2),
    ]
    if n <= 3:
        return verts[:n]
    coords = []
    for i in range(n):
        edge = i % 3
        a, b = verts[edge], verts[(edge + 1) % 3]
        t = (i // 3) / max(1, math.ceil(n / 3))
        coords.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return coords


FORM_SHAPES = ("circle", "line", "perimeter", "grid", "square", "triangle")


def form_points(
    n: int,
    shape: str,
    region: Region | Sequence[float],
    center: Sequence[float] | None = None,
    radius: float | None = None,
) -> list[tuple[float, float]]:
    rg = _as_region(region)
    c = tuple(center) if center is not None else rg.center
    r = float(radius) if radius is not None else min(rg.width, rg.height) / 4.0
    if shape == "circle":
        return sample_circle(n, c, r)
    if shape == "line":
        return sample_line(n, rg)
    if shape == "perimeter":
        return sample_perimeter(n, rg)
    if shape == "grid":
        return sample_grid(n, rg)
    if shape == "square":
        return sample_square(n, c, r * 2)
    if shape == "triangle":
        return sample_triangle(n, rg)
    raise ValueError(f"Unknown form shape '{shape}'. Expected one of {FORM_SHAPES}.")


def lawnmower(
    region: Region | Sequence[float],
    heading: float = 0.0,
    spacing: float = 40.0,
) -> list[tuple[float, float]]:
    """Axis-aligned lawnmower. `heading` of 90 uses vertical lanes; otherwise horizontal."""
    rg = _as_region(region)
    space = max(float(spacing), 1.0)
    vertical = abs(math.sin(math.radians(heading))) > 0.5
    points: list[tuple[float, float]] = []
    if vertical:
        x = rg.x1 + space / 2.0
        going_up = True
        while x <= rg.x2:
            if going_up:
                points.append((x, rg.y1))
                points.append((x, rg.y2))
            else:
                points.append((x, rg.y2))
                points.append((x, rg.y1))
            x += space
            going_up = not going_up
    else:
        y = rg.y1 + space / 2.0
        going_right = True
        while y <= rg.y2:
            if going_right:
                points.append((rg.x1, y))
                points.append((rg.x2, y))
            else:
                points.append((rg.x2, y))
                points.append((rg.x1, y))
            y += space
            going_right = not going_right
    if not points:
        points = [rg.center]
    return points


def assign_round_robin(items: Sequence, n: int) -> list:
    if not items:
        return []
    return [items[i % len(items)] for i in range(n)]
