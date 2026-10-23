import math

import numpy as np


def wrap_heading(heading: float) -> float:
    tau = 2.0 * math.pi
    return (float(heading) % tau + tau) % tau


def bbox_from_pose(x: float, y: float, footprint, heading: float = 0.0):
    fw, fh = float(footprint[0]), float(footprint[1])
    hw, hh = fw / 2.0, fh / 2.0
    cos_h = math.cos(heading)
    sin_h = math.sin(heading)
    xs = []
    ys = []
    for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
        xs.append(x + dx * cos_h - dy * sin_h)
        ys.append(y + dx * sin_h + dy * cos_h)
    return ((min(xs), min(ys)), (max(xs), max(ys)))


class mapObject:
    def __init__(
        self,
        name,
        position,
        boundingBox,
        object_type,
        condition=None,
        properties=None,
        heading=0.0,
        footprint=None,
    ):
        self.name = name  # string
        self.position = position # [x, y] - position of the object
        self.boundingBox = boundingBox  # ((x1, y1), (x2, y2)) - bounding box defining the size/area of the object
        self.object_type = str(object_type).lower()  # lowercase type (e.g., "building", "tree")
        self.condition = condition  # string, e.g., "damaged", "intact", "flooded", "destroyed"
        self.properties = properties or {}  # dict, optional additional properties such as water level, material, etc.
        self.detected = False # has object been detected flag
        self.authored = False  # operator-placed; visible on the COP even if undetected
        (x1, y1), (x2, y2) = self.boundingBox
        self.footprint = (
            (float(footprint[0]), float(footprint[1]))
            if footprint is not None
            else (abs(float(x2) - float(x1)), abs(float(y2) - float(y1)))
        )
        self.heading = wrap_heading(heading)

    def apply_pose(self, x, y, heading=None):
        if heading is not None:
            self.heading = wrap_heading(heading)
        self.position = [float(x), float(y)]
        self.boundingBox = bbox_from_pose(float(x), float(y), self.footprint, self.heading)
        return self

    def _bbox_as_lists(self):
        (x1, y1), (x2, y2) = self.boundingBox
        return [[float(x1), float(y1)], [float(x2), float(y2)]]

    def _compute_radius(self) -> float:
        width, height = self.footprint
        return max(float(width), float(height)) / 2.0

    def __repr__(self):
        return (
            f"mapObject(name={self.name}, position={self.position}, "
            f"boundingBox={self.boundingBox}, type={self.object_type}, "
            f"condition={self.condition}, properties={self.properties})"
        )

    def convert_to_dict(self):
        position = self.position.tolist() if isinstance(self.position, np.ndarray) else list(self.position)
        return {
            "name": self.name,
            "position": position,
            "boundingBox": self._bbox_as_lists(),
            "radius": self._compute_radius(),
            "object_type": self.object_type,
            "condition": self.condition,
            "properties": self.properties,
            "detected": self.detected,
            "authored": bool(getattr(self, "authored", False)),
            "heading": float(getattr(self, "heading", 0.0)),
            "footprint": [float(self.footprint[0]), float(self.footprint[1])],
        }
