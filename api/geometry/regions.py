from __future__ import annotations

from typing import Sequence

from pydantic import BaseModel, Field, model_validator


class Region(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float

    @model_validator(mode="after")
    def _order(self):
        x1, x2 = (self.x1, self.x2) if self.x1 <= self.x2 else (self.x2, self.x1)
        y1, y2 = (self.y1, self.y2) if self.y1 <= self.y2 else (self.y2, self.y1)
        self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2
        return self

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)

    def as_bbox(self) -> list[float]:
        return [self.x1, self.y1, self.x2, self.y2]


def bbox_region(bbox: Sequence[float]) -> Region:
    return Region(x1=bbox[0], y1=bbox[1], x2=bbox[2], y2=bbox[3])


def clip_region(region: Region, bbox: Sequence[float]) -> Region:
    env = bbox_region(bbox)
    return Region(
        x1=max(env.x1, region.x1),
        y1=max(env.y1, region.y1),
        x2=min(env.x2, region.x2),
        y2=min(env.y2, region.y2),
    )


def region_in_bbox(region: Region, bbox: Sequence[float], *, min_span: float = 1.0) -> bool:
    clipped = clip_region(region, bbox)
    return clipped.width >= min_span and clipped.height >= min_span


def point_in_region(point: Sequence[float], region: Region, *, pad: float = 0.0) -> bool:
    x, y = float(point[0]), float(point[1])
    return (region.x1 - pad) <= x <= (region.x2 + pad) and (region.y1 - pad) <= y <= (region.y2 + pad)
