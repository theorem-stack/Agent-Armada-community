from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional, Sequence

from ..config import OBJECT_CATALOG, OCCLUDER_TYPES
from .los import eye_xyz, in_downward_cone, object_aabb, object_height, ray_aabb, target_xyz
from .regions import Region, point_in_region
from .sectors import Sector, SectorGraph

if TYPE_CHECKING:
    from .coverage import OccupancyGrid

PLACE_ANCHORS = (
    "bbox_center",
    "sw_corner",
    "se_corner",
    "nw_corner",
    "ne_corner",
)


def _xy(value) -> tuple[float, float]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    return float(value[0]), float(value[1])


def _region_from_object(obj) -> Region:
    box = getattr(obj, "boundingBox", None)
    if box is not None:
        (x1, y1), (x2, y2) = box
        return Region(x1=float(x1), y1=float(y1), x2=float(x2), y2=float(y2))
    x, y = _xy(obj.position)
    return Region(x1=x, y1=y, x2=x, y2=y)


@dataclass(frozen=True)
class BoundSymbol:
    name: str
    object_type: str
    position: tuple[float, float]
    region: Region
    detected: bool
    condition: Optional[str] = None


def _bound(obj) -> BoundSymbol:
    return BoundSymbol(
        name=obj.name,
        object_type=str(obj.object_type).lower(),
        position=_xy(obj.position),
        region=_region_from_object(obj),
        detected=bool(getattr(obj, "detected", False)),
        condition=getattr(obj, "condition", None),
    )


class SpatialKernel:
    def __init__(
        self,
        bbox: Sequence[float],
        objects: list,
        occupancy: Optional["OccupancyGrid"] = None,
    ):
        self.bbox = [float(v) for v in bbox]
        self.objects = objects
        self.occupancy = occupancy
        self.graph = SectorGraph(self.bbox)
        self._by_name: dict[str, object] = {}
        self._track_seen: dict[str, int] = {}
        self._prev_pose: dict[str, tuple[float, float]] = {}
        self._velocity: dict[str, tuple[float, float]] = {}
        self._contacts: dict[str, str] = {}
        self._last_contact: Optional[str] = None
        self.reindex()

    def reindex(self) -> None:
        self._by_name = {obj.name: obj for obj in self.objects}
        self._track_seen = {
            name: tick for name, tick in self._track_seen.items() if name in self._by_name
        }
        self._prev_pose = {
            name: pose for name, pose in self._prev_pose.items() if name in self._by_name
        }
        self._velocity = {
            name: vel for name, vel in self._velocity.items() if name in self._by_name
        }
        self._contacts = {
            kind: name for kind, name in self._contacts.items() if name in self._by_name
        }
        if self._last_contact and self._last_contact not in self._by_name:
            self._last_contact = None

    def record_motion(self, dt: float = 0.0) -> None:
        for obj in self.objects:
            name = getattr(obj, "name", None)
            if not name:
                continue
            x, y = _xy(obj.position)
            prev = self._prev_pose.get(name)
            if prev is not None and dt > 0:
                self._velocity[name] = ((x - prev[0]) / dt, (y - prev[1]) / dt)
            elif prev is not None:
                self._velocity[name] = (x - prev[0], y - prev[1])
            else:
                self._velocity[name] = (0.0, 0.0)
            self._prev_pose[name] = (x, y)

    def velocity(self, name: str) -> tuple[float, float]:
        return self._velocity.get(name, (0.0, 0.0))

    def object(self, name: str):
        return self._by_name.get(name)

    def bind(self, name: Optional[str]) -> Optional[BoundSymbol]:
        if not name:
            return None
        obj = self._by_name.get(name)
        if obj is None:
            return None
        return _bound(obj)

    def note_contact(self, name: str, object_type: str) -> None:
        if not name:
            return
        kind = str(object_type).lower()
        self._contacts[kind] = name
        self._last_contact = name

    def latest_contact(self, object_type: Optional[str] = None) -> Optional[BoundSymbol]:
        if object_type:
            kind = object_type.lower()
            stored = self._contacts.get(kind)
            if stored:
                bound = self.bind(stored)
                if bound is not None:
                    return bound
            hits = [item for item in self.detected() if item.object_type == kind]
            return hits[-1] if hits else None
        if self._last_contact:
            bound = self.bind(self._last_contact)
            if bound is not None:
                return bound
        hits = [item for item in self.detected() if item.object_type in ("person", "vehicle")]
        return hits[-1] if hits else None

    def resolve_object(
        self,
        name: Optional[str] = None,
        *,
        prefer_type: Optional[str] = None,
    ) -> Optional[BoundSymbol]:
        if name:
            bound = self.bind(name)
            if bound is not None:
                return bound
            key = name.lower()
            if key == "last_contact":
                return self.latest_contact(prefer_type)
            if key in OBJECT_CATALOG:
                return self.latest_contact(key)
            return self.anchor(name)
        return self.latest_contact(prefer_type)

    def anchor(self, name: Optional[str]) -> Optional[BoundSymbol]:
        if not name:
            return None
        bound = self.bind(name)
        if bound is not None:
            return bound
        x1, y1, x2, y2 = self.bbox
        if name == "bbox_center":
            cx, cy = self.center()
            return BoundSymbol(
                name=name,
                object_type="anchor",
                position=(cx, cy),
                region=Region(x1=x1, y1=y1, x2=x2, y2=y2),
                detected=True,
            )
        corners = {
            "sw_corner": (x1, y1),
            "se_corner": (x2, y1),
            "nw_corner": (x1, y2),
            "ne_corner": (x2, y2),
        }
        point = corners.get(name)
        if point is None:
            return None
        px, py = point
        return BoundSymbol(
            name=name,
            object_type="anchor",
            position=(px, py),
            region=Region(x1=px, y1=py, x2=px, y2=py),
            detected=True,
        )

    def nearest(
        self,
        point: Sequence[float],
        *,
        object_type: Optional[str] = None,
        detected: Optional[bool] = None,
    ) -> Optional[BoundSymbol]:
        px, py = _xy(point)
        want_type = object_type.lower() if object_type else None
        best = None
        best_d = None
        for obj in self.objects:
            if want_type and str(obj.object_type).lower() != want_type:
                continue
            if detected is not None and bool(obj.detected) != detected:
                continue
            x, y = _xy(obj.position)
            dist = (x - px) ** 2 + (y - py) ** 2
            if best_d is None or dist < best_d:
                best_d = dist
                best = obj
        return _bound(best) if best is not None else None

    def in_region(
        self,
        region: Region,
        *,
        object_type: Optional[str] = None,
        detected: Optional[bool] = None,
    ) -> list[BoundSymbol]:
        want_type = object_type.lower() if object_type else None
        hits = []
        for obj in self.objects:
            if want_type and str(obj.object_type).lower() != want_type:
                continue
            if detected is not None and bool(obj.detected) != detected:
                continue
            if point_in_region(_xy(obj.position), region):
                hits.append(_bound(obj))
        return hits

    def standoff(
        self,
        name: str,
        toward: Sequence[float],
        distance: float,
    ) -> Optional[tuple[float, float]]:
        bound = self.bind(name)
        if bound is None:
            return None
        ox, oy = bound.position
        tx, ty = _xy(toward)
        dx, dy = tx - ox, ty - oy
        norm = (dx * dx + dy * dy) ** 0.5 or 1.0
        px = ox + (dx / norm) * float(distance)
        py = oy + (dy / norm) * float(distance)
        x1, y1, x2, y2 = self.bbox
        px = min(max(px, x1), x2)
        py = min(max(py, y1), y2)
        return (px, py)

    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    def observe_free(self, x: float, y: float) -> None:
        if self.occupancy is not None:
            self.occupancy.observe_free(x, y)

    def observe_occupied(self, x: float, y: float) -> None:
        if self.occupancy is not None:
            self.occupancy.observe_occupied(x, y)

    def probability_at(self, point: Sequence[float]) -> Optional[float]:
        if self.occupancy is None:
            return None
        x, y = _xy(point)
        return self.occupancy.probability(x, y)

    def uncovered_mass(self, region: Optional[Region] = None) -> float:
        if self.occupancy is None:
            return 1.0
        return self.occupancy.uncovered_mass(region)

    def detected(self) -> list[BoundSymbol]:
        return [_bound(obj) for obj in self.objects if bool(getattr(obj, "detected", False))]

    def undetected_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for obj in self.objects:
            if bool(getattr(obj, "detected", False)):
                continue
            key = str(obj.object_type).lower()
            counts[key] = counts.get(key, 0) + 1
        return counts

    def sector_uncovered(self) -> dict[str, float]:
        return {
            sector.id: round(self.uncovered_mass(sector.region), 4)
            for sector in self.graph.all()
        }

    def reset_belief(self) -> None:
        if self.occupancy is not None:
            self.occupancy.reset()

    def sectors(self) -> list[Sector]:
        return self.graph.all()

    def uncovered_sectors(self) -> list[Sector]:
        return sorted(
            self.graph.all(),
            key=lambda sector: self.uncovered_mass(sector.region),
            reverse=True,
        )

    def nearest_ids(
        self,
        point: Sequence[float],
        poses: dict[int, tuple[float, float]],
        k: int,
    ) -> list[int]:
        if not poses:
            return []
        px, py = _xy(point)
        ranked = sorted(
            poses,
            key=lambda aid: (poses[aid][0] - px) ** 2 + (poses[aid][1] - py) ** 2,
        )
        return ranked[: max(1, min(int(k), len(ranked)))]

    def _resolve(self, obj):
        if obj is None:
            return None
        if isinstance(obj, str):
            return self._by_name.get(obj)
        return obj

    def occluded(
        self,
        eye,
        obj,
        occluder_types: Sequence[str] = OCCLUDER_TYPES,
    ) -> bool:
        target = self._resolve(obj)
        if target is None:
            return False
        origin = eye_xyz(eye)
        dest = target_xyz(target)
        dx = dest[0] - origin[0]
        dy = dest[1] - origin[1]
        dz = dest[2] - origin[2]
        dist = (dx * dx + dy * dy + dz * dz) ** 0.5
        if dist < 1e-8:
            return False
        direction = (dx / dist, dy / dist, dz / dist)
        want = {str(kind).lower() for kind in occluder_types}
        for other in self.objects:
            if other is target or getattr(other, "name", None) == getattr(target, "name", None):
                continue
            if str(getattr(other, "object_type", "")).lower() not in want:
                continue
            hit = ray_aabb(origin, direction, object_aabb(other), dist)
            if hit is not None and hit < dist - 1e-3:
                return True
        return False

    def visible(self, eye, obj) -> bool:
        target = self._resolve(obj)
        if target is None:
            return False
        if not in_downward_cone(eye_xyz(eye), target_xyz(target)):
            return False
        return not self.occluded(eye, target)

    def observers(self, obj, eyes: dict) -> list[int]:
        target = self._resolve(obj)
        if target is None or not eyes:
            return []
        found: list[int] = []
        for aid, eye in eyes.items():
            if self.visible(eye, target):
                found.append(int(aid))
        return found

    def fused_tracks(self, eyes: dict, tick: int = 0) -> list[dict]:
        out: list[dict] = []
        for obj in self.objects:
            if not bool(getattr(obj, "detected", False)):
                continue
            obs = self.observers(obj, eyes)
            if obs:
                self._track_seen[obj.name] = int(tick)
            last = self._track_seen.get(obj.name, int(tick) if obs else 0)
            n = len(obs)
            confidence = 1.0 - 0.5 ** n if n else 0.25
            x, y = _xy(obj.position)
            vx, vy = self._velocity.get(obj.name, (0.0, 0.0))
            out.append(
                {
                    "name": obj.name,
                    "object_type": str(obj.object_type).lower(),
                    "position": [x, y],
                    "z": object_height(obj) * 0.5,
                    "observers": obs,
                    "last_seen_tick": last,
                    "confidence": round(confidence, 4),
                    "velocity": [round(vx, 4), round(vy, 4)],
                }
            )
        return out

    def assign_sectors(
        self,
        sites: dict[str, tuple[float, float]],
    ) -> dict[str, list[Sector]]:
        assigned: dict[str, list[Sector]] = {name: [] for name in sites}
        if not sites:
            return assigned
        for sector in self.uncovered_sectors():
            cx, cy = sector.region.center
            nearest = min(
                sites,
                key=lambda name: (sites[name][0] - cx) ** 2 + (sites[name][1] - cy) ** 2,
            )
            assigned[nearest].append(sector)
        extras = [s for bucket in assigned.values() for s in bucket]
        empty = [name for name, bucket in assigned.items() if not bucket]
        if empty and extras:
            extras.sort(key=lambda s: self.uncovered_mass(s.region), reverse=True)
            for name, sector in zip(empty, extras):
                for other, bucket in assigned.items():
                    if sector in bucket and other != name and len(bucket) > 1:
                        bucket.remove(sector)
                        assigned[name].append(sector)
                        break
        return assigned
