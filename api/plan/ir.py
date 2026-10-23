from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from ..geometry.regions import Region

AnchorName = Literal["bbox_center", "sw_corner", "se_corner", "nw_corner", "ne_corner"]


class ActionName(str, Enum):
    allocate = "Allocate"
    goto = "GoTo"
    form = "Form"
    search = "Search"
    hold = "Hold"
    investigate = "Investigate"
    follow = "Follow"


class TaskStatus(str, Enum):
    pending = "pending"
    active = "active"
    success = "success"
    fail = "fail"


class PredicateTimeout(BaseModel):
    type: Literal["Timeout"] = "Timeout"
    seconds: Optional[float] = None


class PredicateAgentsInRegion(BaseModel):
    type: Literal["AgentsInRegion"] = "AgentsInRegion"
    region: Optional[Region] = None
    min_count: Optional[int] = None
    pad: float = 0.0


class PredicateDetected(BaseModel):
    type: Literal["Detected"] = "Detected"
    object_type: str
    min_count: int = 1


class PredicateCoverage(BaseModel):
    type: Literal["Coverage"] = "Coverage"
    region: Optional[Region] = None
    min: float = 0.8


Predicate = Annotated[
    Union[PredicateTimeout, PredicateAgentsInRegion, PredicateDetected, PredicateCoverage],
    Field(discriminator="type"),
]


class Overlays(BaseModel):
    avoid: list[str] = Field(default_factory=list)
    cruise_altitude: Optional[float] = None


class GroupSpec(BaseModel):
    name: str
    agent_ids: Optional[list[int]] = None
    count: Optional[int] = None
    role: Optional[str] = None


class TaskBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = ""
    objective: str = ""
    agent_ids: Optional[list[int]] = None
    group: Optional[str] = None


class AllocateTask(TaskBase):
    action: Literal["Allocate"] = "Allocate"
    groups: Optional[list[GroupSpec]] = None


class GoToTask(TaskBase):
    action: Literal["GoTo"] = "GoTo"
    target: Optional[AnchorName] = None
    object_id: Optional[str] = None


class FormTask(TaskBase):
    action: Literal["Form"] = "Form"
    shape: Literal["circle", "line", "perimeter", "grid", "square", "triangle"]
    target: Optional[AnchorName] = None
    object_id: Optional[str] = None


class SearchTask(TaskBase):
    action: Literal["Search"] = "Search"
    pattern: Literal["lawnmower"] = "lawnmower"
    target: Optional[AnchorName] = None
    object_id: Optional[str] = None


class HoldTask(TaskBase):
    action: Literal["Hold"] = "Hold"
    target: Optional[AnchorName] = None
    object_id: Optional[str] = None


class InvestigateTask(TaskBase):
    action: Literal["Investigate"] = "Investigate"
    object_id: Optional[str] = None
    standoff: Optional[float] = None


class FollowTask(TaskBase):
    action: Literal["Follow"] = "Follow"
    object_id: Optional[str] = None
    standoff: Optional[float] = None


Task = Annotated[
    Union[AllocateTask, GoToTask, FormTask, SearchTask, HoldTask, InvestigateTask, FollowTask],
    Field(discriminator="action"),
]


class EventRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    when: Literal["Detected", "Lost", "Moved", "Reacquired"] = "Detected"
    object_type: str
    then: Task


class Plan(BaseModel):
    version: int = 1
    tasks: list[Task]
    groups: list[GroupSpec] = Field(default_factory=list)
    overlays: Overlays = Field(default_factory=Overlays)
    on_event: list[EventRule] = Field(default_factory=list)


class PlannerResponse(BaseModel):
    unsupported: bool = False
    error: Optional[str] = None
    plan: Optional[Plan] = None


PREDICATE_ADAPTER = TypeAdapter(Predicate)
TASK_ADAPTER = TypeAdapter(Task)


def action_key(task) -> str:
    action = getattr(task, "action", "")
    return action.value if isinstance(action, Enum) else str(action)
