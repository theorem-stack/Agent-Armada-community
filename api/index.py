import asyncio
from typing import List, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import ASSESS_DT, OBJECT_CATALOG
from .connectionManager import ConnectionManager
from .planner.planner import plan_mission
from .session.store import SessionStore
from .session.session import Session
from .session.world import clone_map
from .simulation.maps import maps

app = FastAPI(docs_url="/api/py/docs", openapi_url="/api/py/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = SessionStore()
manager = ConnectionManager()


class SessionCreate(BaseModel):
    map_name: str = "hurricane_map"
    spawn: Optional[List[float]] = None


class SpawnInput(BaseModel):
    x: float
    y: float


class PlaceObjectInput(BaseModel):
    object_type: str
    x: float
    y: float


class MoveObjectInput(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    heading: Optional[float] = None


class MissionInput(BaseModel):
    user_mission_statement: str


class MapResponse(BaseModel):
    name: str
    position: List[float]
    boundingBox: tuple
    object_type: str
    condition: Optional[str] = None
    properties: Optional[dict] = None
    detected: bool = False
    authored: bool = False


@app.on_event("startup")
async def startup_event():
    print("FastAPI server has started. Waiting for session create.")


@app.get("/api/py/catalog")
async def get_catalog():
    return [
        {
            "object_type": kind,
            "label": spec["label"],
            "footprint": list(spec["footprint"]),
            "condition": spec["condition"],
        }
        for kind, spec in OBJECT_CATALOG.items()
    ]


@app.get("/api/py/maps/{map_name}", response_model=List[MapResponse])
async def get_map(map_name: str):
    if map_name not in maps:
        raise HTTPException(status_code=404, detail="Map not found")
    return clone_map(map_name)


@app.post("/api/py/sessions")
async def create_session(body: SessionCreate):
    if body.map_name not in maps:
        raise HTTPException(status_code=404, detail="Map not found")
    spawn = None
    if body.spawn and len(body.spawn) >= 2:
        spawn = (float(body.spawn[0]), float(body.spawn[1]))
    session = Session.create(body.map_name, store=store, spawn=spawn)
    await session.start()
    return {"session_id": session.id, "snapshot": session.snapshot}


@app.get("/api/py/sessions/{session_id}")
async def get_session(session_id: str):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.snapshot


@app.post("/api/py/sessions/{session_id}/mission")
async def submit_mission(session_id: str, mission_input: MissionInput):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    statement = mission_input.user_mission_statement.strip()
    if not statement:
        return {"status": "Failed to generate mission plan", "error": "Mission statement cannot be empty.", "ok": False}
    return session.request_mission(statement, plan_mission)


@app.post("/api/py/sessions/{session_id}/spawn")
async def set_session_spawn(session_id: str, body: SpawnInput):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    origin = session.set_spawn(body.x, body.y)
    return {"ok": True, "spawn": [origin[0], origin[1]], "snapshot": session.snapshot}


@app.post("/api/py/sessions/{session_id}/objects")
async def place_object(session_id: str, body: PlaceObjectInput):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        obj = session.place_object(body.object_type, body.x, body.y)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "object": obj.convert_to_dict(), "snapshot": session.snapshot}


@app.patch("/api/py/sessions/{session_id}/objects/{name}")
async def move_object(session_id: str, name: str, body: MoveObjectInput):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        if body.x is None and body.y is None and body.heading is None:
            raise HTTPException(status_code=400, detail="Expected x, y, or heading")
        obj = session.relocate_object(name, body.x, body.y, body.heading)
    except KeyError:
        raise HTTPException(status_code=404, detail="Object not found")
    return {"ok": True, "object": obj.convert_to_dict(), "snapshot": session.snapshot}


@app.delete("/api/py/sessions/{session_id}/objects/{name}")
async def delete_object(session_id: str, name: str):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        obj = session.delete_object(name)
    except KeyError:
        raise HTTPException(status_code=404, detail="Object not found")
    return {"ok": True, "object": obj.convert_to_dict(), "snapshot": session.snapshot}


@app.post("/api/py/sessions/{session_id}/abort")
async def abort_session(session_id: str):
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    session.abort()
    return {"status": "Session aborted", "snapshot": session.snapshot, "ok": True}


@app.websocket("/ws/sessions/{session_id}")
async def websocket_session(websocket: WebSocket, session_id: str):
    session = store.get(session_id)
    if session is None:
        await websocket.accept()
        await websocket.close(code=1008)
        return
    await manager.connect(websocket)
    try:
        await manager.send_data(session.snapshot, websocket)
        while True:
            await manager.send_data(session.snapshot, websocket)
            await asyncio.sleep(ASSESS_DT)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
