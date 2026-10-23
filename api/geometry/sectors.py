from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .regions import Region, bbox_region


@dataclass(frozen=True)
class Sector:
    id: str
    row: int
    col: int
    region: Region
    neighbors: tuple[str, ...]


class SectorGraph:
    def __init__(self, bbox: Sequence[float], rows: int = 2, cols: int = 2):
        env = bbox_region(bbox)
        self.rows = max(1, int(rows))
        self.cols = max(1, int(cols))
        self._sectors: dict[str, Sector] = {}
        width = env.width / self.cols
        height = env.height / self.rows
        for r in range(self.rows):
            for c in range(self.cols):
                sid = f"{r}_{c}"
                region = Region(
                    x1=env.x1 + c * width,
                    y1=env.y1 + r * height,
                    x2=env.x1 + (c + 1) * width,
                    y2=env.y1 + (r + 1) * height,
                )
                neighbors = []
                if r > 0:
                    neighbors.append(f"{r - 1}_{c}")
                if r + 1 < self.rows:
                    neighbors.append(f"{r + 1}_{c}")
                if c > 0:
                    neighbors.append(f"{r}_{c - 1}")
                if c + 1 < self.cols:
                    neighbors.append(f"{r}_{c + 1}")
                self._sectors[sid] = Sector(
                    id=sid,
                    row=r,
                    col=c,
                    region=region,
                    neighbors=tuple(neighbors),
                )

    def all(self) -> list[Sector]:
        return list(self._sectors.values())

    def get(self, sector_id: str) -> Sector | None:
        return self._sectors.get(sector_id)
