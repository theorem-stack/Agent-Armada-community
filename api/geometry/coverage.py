from __future__ import annotations

from math import ceil
from typing import Optional

import numpy as np

from .regions import Region

OCCUPANCY_PRIOR = 0.2
OCCUPANCY_L_FREE = -0.55
OCCUPANCY_L_OCC = 1.1
OCCUPANCY_L_MIN = -5.0
OCCUPANCY_L_MAX = 5.0


def _logit(p: float) -> float:
    p = min(max(float(p), 1e-6), 1.0 - 1e-6)
    return float(np.log(p / (1.0 - p)))


def _sigmoid(log_odds: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-log_odds))


class CoverageGrid:
    def __init__(self, width: float, height: float, cell_size: float):
        self.cell_size = float(cell_size)
        self.width = float(width)
        self.height = float(height)
        self.cols = max(1, ceil(self.width / self.cell_size))
        self.rows = max(1, ceil(self.height / self.cell_size))
        self.visited = np.zeros((self.rows, self.cols), dtype=bool)

    def reset(self) -> None:
        self.visited[:] = False

    def cell(self, x: float, y: float) -> Optional[tuple[int, int]]:
        if x != x or y != y:
            return None
        c = int(x / self.cell_size)
        r = int(y / self.cell_size)
        if 0 <= r < self.rows and 0 <= c < self.cols:
            return r, c
        return None

    def paint(self, x: float, y: float) -> None:
        rc = self.cell(x, y)
        if rc is None:
            return
        r, c = rc
        self.visited[r, c] = True

    def _slices(self, region: Optional[Region]) -> tuple[slice, slice]:
        if region is None:
            return slice(None), slice(None)
        c0 = max(0, int(region.x1 / self.cell_size))
        c1 = min(self.cols, int(region.x2 / self.cell_size) + 1)
        r0 = max(0, int(region.y1 / self.cell_size))
        r1 = min(self.rows, int(region.y2 / self.cell_size) + 1)
        return slice(r0, r1), slice(c0, c1)

    def _window(self, region: Optional[Region]):
        rs, cs = self._slices(region)
        return self.visited[rs, cs]

    def fraction(self, region: Optional[Region] = None) -> float:
        view = self._window(region)
        if view.size == 0:
            return 0.0
        return float(view.sum()) / float(view.size)

    def summary(self) -> dict:
        return {
            "cols": self.cols,
            "rows": self.rows,
            "cell_size": self.cell_size,
            "fraction": self.fraction(),
        }


class OccupancyGrid:
    def __init__(self, coverage: CoverageGrid, prior: float = OCCUPANCY_PRIOR):
        self.coverage = coverage
        self.prior = float(prior)
        self.l0 = _logit(self.prior)
        self.log_odds = np.full((coverage.rows, coverage.cols), self.l0, dtype=float)

    def reset(self) -> None:
        self.log_odds[:] = self.l0

    def _update(self, x: float, y: float, delta: float) -> None:
        rc = self.coverage.cell(x, y)
        if rc is None:
            return
        r, c = rc
        self.log_odds[r, c] = min(
            max(self.log_odds[r, c] + delta, OCCUPANCY_L_MIN),
            OCCUPANCY_L_MAX,
        )

    def observe_free(self, x: float, y: float) -> None:
        self._update(x, y, OCCUPANCY_L_FREE)

    def observe_occupied(self, x: float, y: float) -> None:
        self._update(x, y, OCCUPANCY_L_OCC)

    def probability(self, x: float, y: float) -> Optional[float]:
        rc = self.coverage.cell(x, y)
        if rc is None:
            return None
        r, c = rc
        return float(_sigmoid(self.log_odds[r, c]))

    def uncovered_mass(self, region: Optional[Region] = None) -> float:
        rs, cs = self.coverage._slices(region)
        view = self.log_odds[rs, cs]
        if view.size == 0 or self.prior <= 0:
            return 0.0
        mass = float(_sigmoid(view).mean() / self.prior)
        return min(max(mass, 0.0), 4.0)
