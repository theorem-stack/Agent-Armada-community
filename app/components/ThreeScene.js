"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import Agent from "./Agent";
import Target from "./Target";
import Obstacle from "./Obstacle";
import SceneHUD from "./SceneHUD";
import SceneLabels from "./SceneLabels";
import {
  getColorBySwarmId,
  convertEnvPositionToThree,
  convertThreePositionToEnv,
  convertEnvRadiusToThree,
  createMapObjects,
  shouldShowMapObject,
  seatMapObject,
  updateDetections,
  pulseDetections,
  labelWorldZ,
} from "../lib/helpers";
import {
  TERRAIN_HEIGHT_MAP,
  ENV_WIDTH,
  ENV_HEIGHT,
  THREE_WIDTH,
  THREE_HEIGHT,
  visualHeightForType,
  visualFootprint,
  envToWorld,
  isObjectOfInterest,
} from "../data/globalVars";
import { attachIndicatorsToAgent, updateAgentIndicators } from "./visuals/indicators";
import {
  createTerrain,
  createBackdrop,
  createFrostedSceneFrame,
  createAoiBoundary,
  setupSceneLighting,
  createOrthoControls,
  createOrbitControls,
  createWalkControls,
  fitCameraSizeToAoi,
  WORLD_PAN_SCALE,
} from "./visuals/spatialFrame";
import { buildHeightField, surfaceZAtThree } from "./visuals/heightField";
import { createContours } from "./visuals/contours";
import { createDistanceFrame, RETICLE_OPACITY } from "./visuals/distanceFrame";
import { createTrackLayer } from "./visuals/tracks";
import { createFusionLayer } from "./visuals/fusion";
import { TAC } from "./visuals/palette";
import { createSpawnMarker, createUserMarker } from "./visuals/tacticalMarkers";
import {
  createSelectionHighlight,
  gizmoRadiusFor,
} from "./visuals/selectionHighlight";
import { useWebSocketData } from "./WebSocketContext";

const XRAY_OCCLUDERS = new Set(["container", "building", "tree"]);

function footprintForTrack(track, mapObjects) {
  const mapped = Array.isArray(mapObjects)
    ? mapObjects.find((obj) => obj.name === track.name)
    : null;
  const objectType = track.object_type || mapped?.object_type;
  const box = track.boundingBox || mapped?.boundingBox;
  const envFp = box
    ? [box[1][0] - box[0][0], box[1][1] - box[0][1]]
    : mapped?.footprint;
  const [width, depth] = visualFootprint(objectType, envFp || [0.8, 0.8]);
  return { width, depth };
}

function xrayAncestor(obj) {
  let current = obj;
  while (current) {
    const ud = current.userData || {};
    if (ud.kind || ud.object_type || ud.name || current.name) return current;
    current = current.parent;
  }
  return obj;
}

function isXrayOccluder(obj) {
  const node = xrayAncestor(obj);
  const ud = node.userData || {};
  const kind = String(ud.kind || "").toLowerCase();
  const type = String(ud.object_type || "").toLowerCase();
  return XRAY_OCCLUDERS.has(kind) || XRAY_OCCLUDERS.has(type);
}

function isXrayContact(obj, trackName) {
  if (!trackName) return false;
  let current = obj;
  while (current) {
    const ud = current.userData || {};
    if (current.name === trackName || ud.name === trackName || ud.id === trackName) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function sampleOccluded(raycaster, origin, dest, mapRoot, trackName) {
  const dir = dest.clone().sub(origin);
  const dist = dir.length();
  if (dist < envToWorld(0.5)) return false;
  dir.multiplyScalar(1 / dist);
  raycaster.set(origin, dir);
  raycaster.near = envToWorld(0.2);
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(mapRoot.children, true);
  for (const hit of hits) {
    if (hit.object.isLine || hit.object.isLineSegments || hit.object.isLineLoop) continue;
    if (!hit.object.isMesh) continue;
    if (isXrayContact(hit.object, trackName)) return false;
    if (isXrayOccluder(hit.object)) return true;
  }
  return false;
}

/** True only when every body sample is blocked by a volume occluder. */
function contactHiddenFromCamera(camera, mapRoot, raycaster, localPos, height, trackName) {
  if (!camera || !mapRoot) return false;
  const origin = new THREE.Vector3();
  camera.getWorldPosition(origin);
  const fractions = [0.25, 0.55, 0.85];
  for (const t of fractions) {
    const dest = new THREE.Vector3(localPos.x, localPos.y, localPos.z + height * t);
    mapRoot.localToWorld(dest);
    if (!sampleOccluded(raycaster, origin, dest, mapRoot, trackName)) return false;
  }
  return true;
}

const LABEL_PRIORITY = { user: 0, detection: 1, map: 2, contour: 3 };
const MAX_LABELS = 18;
const LABEL_MIN_GAP_PX = 36;
const LABEL_OBJECT_PAD_PX = 8;
/** Show contour elevation tags when camera half-height is at or below this (incl. default fit). */
const CONTOUR_LABEL_MAX_ZOOM = 7.5;
/** Env XY where walk starts — north of the shipping container. */
const WALK_START_ENV = [50, 125];
const USER_LABEL_HEX = "#7c5cfc";

const _labelCorner = new THREE.Vector3();
const _labelCenterNdc = new THREE.Vector3();

function objectLabelOffsetPx(label, zoom, viewHeight, view = {}) {
  if (label.type === "contour" || label.type === "range") return { x: 0, y: 0 };

  const fp = label.footprint;
  const w =
    Array.isArray(fp) && fp.length >= 2
      ? (Number(fp[0]) * THREE_WIDTH) / ENV_WIDTH
      : 0.2;
  const d =
    Array.isArray(fp) && fp.length >= 2
      ? (Number(fp[1]) * THREE_HEIGHT) / ENV_HEIGHT
      : 0.2;

  const { camera, mapRoot, viewWidth } = view;
  if (camera && mapRoot && viewWidth > 0 && viewHeight > 0 && label.position) {
    const heading = Number(label.heading) || 0;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const hw = Math.max(w, 1e-4) / 2;
    const hd = Math.max(d, 1e-4) / 2;
    const ox = label.position.x;
    const oy = label.position.y;
    const oz = label.position.z || 0;

    _labelCenterNdc.copy(label.position);
    mapRoot.localToWorld(_labelCenterNdc);
    _labelCenterNdc.project(camera);
    const cy = ((1 - _labelCenterNdc.y) / 2) * viewHeight;

    let topY = cy;
    const corners = [
      [hw, hd],
      [hw, -hd],
      [-hw, hd],
      [-hw, -hd],
    ];
    for (const [lx, ly] of corners) {
      _labelCorner.set(ox + lx * cos - ly * sin, oy + lx * sin + ly * cos, oz);
      mapRoot.localToWorld(_labelCorner);
      _labelCorner.project(camera);
      const sy = ((1 - _labelCorner.y) / 2) * viewHeight;
      if (sy < topY) topY = sy;
    }
    return { x: 0, y: topY - cy - LABEL_OBJECT_PAD_PX };
  }

  const worldPerPx = (Math.max(zoom, 0.05) * 2) / Math.max(viewHeight, 1);
  return { x: 0, y: -(Math.max(d, 0.12) * 0.5) / worldPerPx - LABEL_OBJECT_PAD_PX };
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function clampEnvPoint(x, y) {
  return {
    x: Math.min(Math.max(x, 0), ENV_WIDTH),
    y: Math.min(Math.max(y, 0), ENV_HEIGHT),
  };
}

function terrainScale(terrain) {
  return terrain?.scale?.z ?? 1;
}

/** Cruise altitude is AGL: sit the drone on the exaggerated surface, not z=0. */
function seatDroneAboveTerrain(pos, field, terrain) {
  const surface = surfaceZAtThree(field, pos.x, pos.y, { zScale: terrainScale(terrain) });
  const agl = pos.z;
  pos.z = (Number.isFinite(surface) ? surface : 0) + agl;
  return agl;
}

function isUserMarker(obj) {
  let current = obj;
  while (current) {
    if (current.userData?.kind === "user" || current.userData?.entityType === "user") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function syncUserAvatar(walk, marker, field, viewMode, labelStore) {
  if (!walk || !marker) return;
  const pose = walk.getPose?.();
  if (!pose) return;
  const surface = surfaceZAtThree(field, pose.x, pose.y);
  marker.position.set(pose.x, pose.y, Number.isFinite(surface) ? surface : 0);
  marker.rotation.z = -pose.yaw;
  const show = viewMode !== "walk";
  marker.visible = show;
  if (!show) {
    labelStore?.delete("user");
    return;
  }
  const hz = visualHeightForType("person");
  labelStore?.set("user", {
    id: "user",
    type: "user",
    title: "user",
    objectType: "user",
    footprint: [12, 12],
    color: USER_LABEL_HEX,
    position: new THREE.Vector3(
      pose.x,
      pose.y,
      marker.position.z + hz + envToWorld(2)
    ),
  });
}

function syncWorldObjects(mapRoot, objects, labelStore, field, zScale, editMode = false, skipName = null) {
  if (!mapRoot) return;
  const visible = (objects || []).filter((obj) => shouldShowMapObject(obj, { editMode }));
  const keep = new Set(visible.map((obj) => obj.name));
  const stale = [];
  mapRoot.children.forEach((child) => {
    if (child.userData?.worldObject && !keep.has(child.name)) stale.push(child);
  });
  stale.forEach((mesh) => {
    mapRoot.remove(mesh);
    labelStore?.delete(`map-${mesh.name}`);
    labelStore?.delete(`detection-${mesh.name}`);
  });
  visible.forEach((obj) => {
    let mesh = mapRoot.children.find(
      (child) => child.userData?.worldObject && child.name === obj.name
    );
    if (!mesh) {
      createMapObjects([obj], mapRoot, labelStore, field, zScale, editMode);
      return;
    }
    if (skipName && obj.name === skipName) return;
    const pos = convertEnvPositionToThree(
      obj.position,
      ENV_WIDTH,
      ENV_HEIGHT,
      THREE_WIDTH,
      THREE_HEIGHT
    );
    mesh.position.x = pos.x;
    mesh.position.y = pos.y;
    mesh.rotation.z = Number(obj.heading) || 0;
    mesh.userData.authored = Boolean(obj.authored);
    mesh.userData.boundingBox = obj.boundingBox;
    mesh.userData.heading = Number(obj.heading) || 0;
    if (obj.footprint) mesh.userData.footprint = obj.footprint;
    seatMapObject(mesh, field, zScale);
    const label =
      labelStore?.get(`map-${obj.name}`) || labelStore?.get(`detection-${obj.name}`);
    if (label?.position) {
      label.position.set(
        mesh.position.x,
        mesh.position.y,
        labelWorldZ(mesh.position.z, obj.object_type)
      );
      if (obj.footprint) label.footprint = obj.footprint;
      label.heading = Number(obj.heading) || Number(mesh.userData?.heading) || 0;
    }
  });
}

function pickGroundEnv(el, clientX, clientY, camera, terrain) {
  if (!el || !camera) return null;
  const rect = el.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  if (terrain) {
    const hits = raycaster.intersectObject(terrain, true);
    if (hits[0]) {
      const env = convertThreePositionToEnv(
        hits[0].point,
        ENV_WIDTH,
        ENV_HEIGHT,
        THREE_WIDTH,
        THREE_HEIGHT
      );
      return clampEnvPoint(env.x, env.y);
    }
  }
  const point = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(GROUND_PLANE, point)) return null;
  const env = convertThreePositionToEnv(
    point,
    ENV_WIDTH,
    ENV_HEIGHT,
    THREE_WIDTH,
    THREE_HEIGHT
  );
  return clampEnvPoint(env.x, env.y);
}

function isRotateHandleObject(obj) {
  let current = obj;
  while (current) {
    if (current.userData?.kind === "rotateHandle" || current.name === "rotateHandle") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function headingFromGround(ground, root) {
  if (!ground || !root) return 0;
  const env = convertThreePositionToEnv(
    root.position,
    ENV_WIDTH,
    ENV_HEIGHT,
    THREE_WIDTH,
    THREE_HEIGHT
  );
  return Math.atan2(ground.y - env.y, ground.x - env.x);
}

function attachSelectionHighlight(highlight, root, entity, agents, editMode) {
  if (!highlight) return;
  if (!root || !entity) {
    highlight.clear();
    return;
  }
  const agent =
    entity.type === "agent"
      ? agents?.find((a) => String(a.id) === String(entity.id))
      : null;
  const canTransform =
    Boolean(editMode) && (entity.type === "map" || entity.type === "detection");
  highlight.attach(root, {
    radius: agent?.detectionRadius ?? gizmoRadiusFor(root),
    edit: canTransform,
  });
}

function envFromThreePosition(position) {
  if (!position) return {};
  const env = convertThreePositionToEnv(
    position,
    ENV_WIDTH,
    ENV_HEIGHT,
    THREE_WIDTH,
    THREE_HEIGHT
  );
  return { envX: env.x, envY: env.y, alt: env.alt };
}

/** Resolve pick hit → { entity, root } for readout + selection outline. */
function resolveEntityHit(obj, agentsById) {
  let current = obj;
  while (current) {
    const ud = current.userData || {};
    if (ud.entityType === "agent" || ud.kind === "agent") {
      const agent = agentsById?.get(String(ud.id));
      const pos = agent?.position ?? current.position;
      return {
        root: current,
        entity: {
          type: "agent",
          id: ud.id,
          swarm: ud.target_id ?? agent?.target_id,
          ...envFromThreePosition(pos),
        },
      };
    }
    if (ud.entityType === "target" || ud.kind === "target") {
      return {
        root: current,
        entity: { type: "target", id: ud.id, ...envFromThreePosition(current.position) },
      };
    }
    if (ud.entityType === "obstacle" || ud.kind === "obstacle") {
      return {
        root: current,
        entity: { type: "obstacle", id: ud.id, ...envFromThreePosition(current.position) },
      };
    }
    if (ud.entityType === "detection" || ud.kind === "detection") {
      return {
        root: current,
        entity: {
          type: "detection",
          id: ud.id || current.name,
          objectType: ud.object_type,
          heading: ud.heading,
          ...envFromThreePosition(current.position),
        },
      };
    }
    if (ud.entityType === "mapObject") {
      return {
        root: current,
        entity: {
          type: "map",
          id: ud.name || current.name,
          objectType: ud.object_type,
          heading: ud.heading,
          ...envFromThreePosition(current.position),
        },
      };
    }
    current = current.parent;
  }
  return null;
}

function findEntityRootByReadout(entity, { agents, targets, obstacles, mapRoot }) {
  if (!entity) return null;
  const id = String(entity.id);
  if (entity.type === "agent") {
    return agents?.find((a) => String(a.id) === id)?.mesh ?? null;
  }
  if (entity.type === "target") {
    return targets?.find((t) => String(t.id) === id)?.mesh ?? null;
  }
  if (entity.type === "obstacle") {
    return obstacles?.find((o) => String(o.id) === id)?.mesh ?? null;
  }
  if (!mapRoot) return null;
  let found = null;
  mapRoot.traverse((obj) => {
    if (found) return;
    const ud = obj.userData || {};
    if (entity.type === "detection" && (ud.kind === "detection" || ud.entityType === "detection")) {
      if (String(ud.id || obj.name) === id) found = obj;
    }
    if (entity.type === "map" && ud.entityType === "mapObject") {
      if (String(ud.name || obj.name) === id) found = obj;
    }
  });
  return found;
}

/** Refresh a pinned readout from live scene entities (keeps panel data in motion). */
function refreshEntityReadout(entity, { agents, targets, obstacles, mapRoot }) {
  if (!entity) return null;
  const id = String(entity.id);

  if (entity.type === "agent") {
    const agent = agents?.find((a) => String(a.id) === id);
    if (!agent) return entity;
    return {
      type: "agent",
      id: agent.id,
      swarm: agent.target_id,
      ...envFromThreePosition(agent.position),
    };
  }
  if (entity.type === "target") {
    const target = targets?.find((t) => String(t.id) === id);
    if (!target) return entity;
    return { type: "target", id: target.id, ...envFromThreePosition(target.position) };
  }
  if (entity.type === "obstacle") {
    const obstacle = obstacles?.find((o) => String(o.id) === id);
    if (!obstacle) return entity;
    return {
      type: "obstacle",
      id: obstacle.id,
      ...envFromThreePosition(obstacle.position),
    };
  }
  if ((entity.type === "map" || entity.type === "detection") && mapRoot) {
    const root = findEntityRootByReadout(entity, { agents, targets, obstacles, mapRoot });
    if (!root) return entity;
    return {
      ...entity,
      heading: root.userData?.heading ?? root.rotation.z,
      ...envFromThreePosition(root.position),
    };
  }
  return entity;
}

const ThreeScene = ({ mapName, selectedIndicator }) => {
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const orthoCameraRef = useRef(null);
  const perspCameraRef = useRef(null);
  const containerRef = useRef(null);
  const controlsRef = useRef(null);
  const orbitControlsRef = useRef(null);
  const walkControlsRef = useRef(null);
  const mapRootRef = useRef(null);
  const terrainRef = useRef(null);
  const distanceFrameRef = useRef(null);
  const trackLayerRef = useRef(null);
  const fusionLayerRef = useRef(null);
  const selectionHighlightRef = useRef(null);
  const spawnMarkerRef = useRef(null);
  const userMarkerRef = useRef(null);
  const placingSpawnRef = useRef(false);
  const stampTypeRef = useRef(null);
  const editModeRef = useRef(false);
  const heightFieldRef = useRef(null);
  const editTransformRef = useRef(null);
  const tracksRef = useRef([]);
  const xrayRaycasterRef = useRef(new THREE.Raycaster());
  const viewModeRef = useRef("map");
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const animRef = useRef(null);
  const indicatorTypeRef = useRef(selectedIndicator);
  const pointerDownRef = useRef({ x: 0, y: 0 });
  const labelStoreRef = useRef(new Map());
  const userZoomedRef = useRef(false);

  const agentsRef = useRef([]);
  const targetsRef = useRef([]);
  const obstaclesRef = useRef([]);

  const [mapData, setMap] = useState(null);
  const [canvasEl, setCanvasEl] = useState(null);
  const [mapYaw, setMapYaw] = useState(0);
  const [interactionMode, setInteractionMode] = useState("pan");
  const [viewMode, setViewMode] = useState("map"); // "map" | "inspect" | "walk"
  const [reticleIntensity, setReticleIntensity] = useState("normal"); // "normal" | "faint"
  const [dragMode, setDragMode] = useState(null); // "pan" | "rotate" | "orbit" while gesturing
  const [hoverEntity, setHoverEntity] = useState(null);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [labels, setLabels] = useState([]);
  const [placingSpawn, setPlacingSpawn] = useState(false);
  const [stampType, setStampType] = useState(null);
  const [editMode, setEditMode] = useState(false);

  const {
    agents,
    targets,
    obstacles,
    new_detections,
    tracks: fusedTracks,
    spawn,
    map_objects: liveMapObjects,
    sessionId,
  } = useWebSocketData();

  useEffect(() => {
    raycasterRef.current.params.Line = { threshold: 0.12 };
    raycasterRef.current.params.Points = { threshold: 0.15 };
    xrayRaycasterRef.current.params.Line = { threshold: 0 };
    xrayRaycasterRef.current.params.Points = { threshold: 0 };
  }, []);

  useEffect(() => {
    distanceFrameRef.current?.setOpacity?.(
      RETICLE_OPACITY[reticleIntensity] ?? RETICLE_OPACITY.normal
    );
  }, [reticleIntensity, canvasEl]);

  const handleControlsChange = useCallback(({ mapYaw: yaw } = {}) => {
    if (typeof yaw === "number") setMapYaw(yaw);
  }, []);

  const handleResetYaw = useCallback(() => {
    const mode = viewModeRef.current;
    if (mode === "inspect") {
      orbitControlsRef.current?.setAzimuth?.(0);
    } else if (mode === "walk") {
      walkControlsRef.current?.setAzimuth?.(0);
    } else {
      controlsRef.current?.setMapYaw?.(0);
    }
    setMapYaw(0);
  }, []);

  const handleInteractionModeChange = useCallback((mode) => {
    const next = mode === "rotate" ? "rotate" : "pan";
    setInteractionMode(next);
    controlsRef.current?.setInteractionMode?.(next);
  }, []);

  const applyViewMode = useCallback((mode) => {
    const next = mode === "inspect" || mode === "walk" ? mode : "map";
    viewModeRef.current = next;
    setViewMode(next);
    if (next !== "map" && editModeRef.current) {
      editModeRef.current = false;
      setEditMode(false);
      stampTypeRef.current = null;
      setStampType(null);
      selectionHighlightRef.current?.clear();
      setSelectedEntity(null);
    }

    const ortho = orthoCameraRef.current;
    const persp = perspCameraRef.current;
    const orthoCtl = controlsRef.current;
    const orbitCtl = orbitControlsRef.current;
    const walkCtl = walkControlsRef.current;
    const mapRoot = mapRootRef.current;
    if (!ortho || !persp || !orthoCtl || !orbitCtl) return;

    orthoCtl.setEnabled(false);
    orbitCtl.setEnabled(false);
    walkCtl?.setEnabled(false);
    if (mapRoot) mapRoot.rotation.z = 0;
    setMapYaw(0);

    if (next === "inspect") {
      orthoCtl.setMapYaw(0);
      orbitCtl.setTarget(ortho.position.x, ortho.position.y, 0);
      orbitCtl.resetPose();
      orbitCtl.setEnabled(true);
      persp.fov = 45;
      persp.near = envToWorld(2);
      persp.far = 200;
      persp.updateProjectionMatrix();
      cameraRef.current = persp;
      distanceFrameRef.current?.setVisible?.(false);
      fusionLayerRef.current?.setPresentation?.({ cones: true, rays: true, ghosts: false });
      syncUserAvatar(
        walkCtl,
        userMarkerRef.current,
        heightFieldRef.current,
        next,
        labelStoreRef.current
      );
      return;
    }

    if (next === "walk") {
      persp.fov = 55;
      persp.near = envToWorld(0.3);
      persp.far = 24;
      persp.updateProjectionMatrix();
      if (walkCtl) {
        walkCtl.setEnabled(true);
      }
      cameraRef.current = persp;
      distanceFrameRef.current?.setVisible?.(false);
      fusionLayerRef.current?.setPresentation?.({ cones: false, rays: false, ghosts: true });
      syncUserAvatar(
        walkCtl,
        userMarkerRef.current,
        heightFieldRef.current,
        next,
        labelStoreRef.current
      );
      const canvas = rendererRef.current?.domElement;
      if (canvas) canvas.tabIndex = 0;
      if (typeof document !== "undefined") {
        const active = document.activeElement;
        if (active && active !== canvas && typeof active.blur === "function") {
          active.blur();
        }
      }
      canvas?.focus?.({ preventScroll: true });
      return;
    }

    ortho.position.set(0, 0, 8);
    ortho.up.set(0, 1, 0);
    ortho.lookAt(0, 0, 0);
    orthoCtl.setMapYaw(0);
    const container = containerRef.current;
    if (container && !userZoomedRef.current) {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (h > 0) orthoCtl.setCameraSize(fitCameraSizeToAoi(w / h));
    }
    orthoCtl.setEnabled(true);
    cameraRef.current = ortho;
    distanceFrameRef.current?.setVisible?.(true);
    fusionLayerRef.current?.setPresentation?.({ cones: false, rays: false, ghosts: false });
    syncUserAvatar(
      walkCtl,
      userMarkerRef.current,
      heightFieldRef.current,
      next,
      labelStoreRef.current
    );
  }, []);

  const handleViewModeChange = useCallback(
    (mode) => {
      applyViewMode(mode);
    },
    [applyViewMode]
  );

  const handleDragStateChange = useCallback(({ dragging, mode }) => {
    const known = mode === "rotate" || mode === "pan" || mode === "orbit" || mode === "look";
    setDragMode(dragging && known ? mode : null);
  }, []);

  const handleReticleIntensityChange = useCallback((intensity) => {
    setReticleIntensity(intensity === "faint" ? "faint" : "normal");
  }, []);

  // Load map data
  useEffect(() => {
    const fetchMapData = async () => {
      try {
        const response = await fetch(`/api/py/maps/${mapName}`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            `Error fetching map data: ${errorData.detail || response.statusText}`
          );
        }
        const data = await response.json();
        setMap(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error("Error fetching map data:", error);
        setMap([]);
      }
    };
    fetchMapData();
  }, [mapName]);

  // Initialize scene once map fetch settles
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapData === null) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    setupSceneLighting(scene);

    labelStoreRef.current = new Map();
    userZoomedRef.current = false;

    const aspect = container.clientWidth / Math.max(container.clientHeight, 1);
    const cameraSize = fitCameraSizeToAoi(aspect);
    const camera = new THREE.OrthographicCamera(
      -cameraSize * aspect,
      cameraSize * aspect,
      cameraSize,
      -cameraSize,
      0.1,
      1000
    );
    camera.position.set(0, 0, 8);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;
    orthoCameraRef.current = camera;

    const persp = new THREE.PerspectiveCamera(45, aspect, envToWorld(2), 200);
    persp.up.set(0, 0, 1);
    perspCameraRef.current = persp;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(TAC.sceneBg, 1);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const mapRoot = new THREE.Group();
    mapRoot.name = "mapRoot";
    mapRootRef.current = mapRoot;
    scene.add(mapRoot);

    const field = buildHeightField(TERRAIN_HEIGHT_MAP, 96);
    heightFieldRef.current = field;
    const { group: contourGroup, labels: contourLabels } = createContours(field);

    // View-anchored overlay: stays centred on the operator's view, never rotates
    const distanceFrame = createDistanceFrame();
    distanceFrameRef.current = distanceFrame;
    scene.add(distanceFrame.group);

    mapRoot.add(createBackdrop());
    mapRoot.add(createFrostedSceneFrame(field));
    const terrain = createTerrain(field);
    terrainRef.current = terrain;
    mapRoot.add(terrain);
    mapRoot.add(contourGroup);
    mapRoot.add(createAoiBoundary());

    contourLabels.forEach((label) => labelStoreRef.current.set(label.id, label));

    const tracks = createTrackLayer();
    trackLayerRef.current = tracks;
    mapRoot.add(tracks.group);

    const fusion = createFusionLayer();
    fusion.setInspecting(false);
    fusionLayerRef.current = fusion;
    mapRoot.add(fusion.group);

    const selectionHighlight = createSelectionHighlight();
    selectionHighlightRef.current = selectionHighlight;
    mapRoot.add(selectionHighlight.group);

    const spawnMarker = createSpawnMarker();
    spawnMarkerRef.current = spawnMarker;
    mapRoot.add(spawnMarker);

    const walkStart = convertEnvPositionToThree(
      WALK_START_ENV,
      ENV_WIDTH,
      ENV_HEIGHT,
      THREE_WIDTH,
      THREE_HEIGHT
    );
    const userMarker = createUserMarker();
    userMarkerRef.current = userMarker;
    mapRoot.add(userMarker);

    if (mapData?.length) {
      createMapObjects(mapData, mapRoot, labelStoreRef.current, field, 1);
    }

    const controls = createOrthoControls(camera, renderer.domElement, {
      mapRoot,
      // Rectangular AOI (10×7.5) — pan limits are per-axis, not square.
      contentBounds: {
        halfWidth: THREE_WIDTH / 2,
        halfHeight: THREE_HEIGHT / 2,
      },
      // Frosted workspace scaled independently on each axis.
      bounds: {
        halfWidth: (THREE_WIDTH * WORLD_PAN_SCALE) / 2,
        halfHeight: (THREE_HEIGHT * WORLD_PAN_SCALE) / 2,
      },
      minZoom: 0.75,
      maxZoom: (aspect) => fitCameraSizeToAoi(aspect),
      interactionMode: "pan",
      onChange: handleControlsChange,
      onDragStateChange: handleDragStateChange,
      onUserZoom: () => {
        userZoomedRef.current = true;
      },
    });
    controlsRef.current = controls;

    const orbit = createOrbitControls(persp, renderer.domElement, {
      contentBounds: {
        halfWidth: THREE_WIDTH / 2,
        halfHeight: THREE_HEIGHT / 2,
      },
      bounds: {
        halfWidth: (THREE_WIDTH * WORLD_PAN_SCALE) / 2,
        halfHeight: (THREE_HEIGHT * WORLD_PAN_SCALE) / 2,
      },
      onChange: handleControlsChange,
      onDragStateChange: handleDragStateChange,
    });
    orbit.setEnabled(false);
    orbitControlsRef.current = orbit;

    const walk = createWalkControls(persp, renderer.domElement, {
      bounds: {
        halfWidth: (THREE_WIDTH * WORLD_PAN_SCALE) / 2,
        halfHeight: (THREE_HEIGHT * WORLD_PAN_SCALE) / 2,
      },
      surfaceAt: (wx, wy) => surfaceZAtThree(heightFieldRef.current, wx, wy),
      onChange: handleControlsChange,
      onDragStateChange: handleDragStateChange,
    });
    walk.setEnabled(false);
    walk.setPose(walkStart.x, walkStart.y, Math.PI, 0);
    walkControlsRef.current = walk;
    syncUserAvatar(
      walk,
      userMarker,
      heightFieldRef.current,
      "map",
      labelStoreRef.current
    );

    viewModeRef.current = "map";
    setViewMode("map");
    setMapYaw(0);
    setInteractionMode("pan");
    setDragMode(null);

    const viewSize = { w: 0, h: 0 };

    const setSize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      viewSize.w = w;
      viewSize.h = h;
      renderer.setSize(w, h, false);
      controls.setAspectFromSize(w, h);
      orbit.setAspectFromSize(w, h);
      walk.setAspectFromSize(w, h);
      if (!userZoomedRef.current && viewModeRef.current === "map") {
        controls.setCameraSize(fitCameraSizeToAoi(w / h));
      }
    };
    setSize();

    const resizeObserver = new ResizeObserver(setSize);
    resizeObserver.observe(container);

    let lastLabelUpdate = 0;
    let frameLabels = [];
    const projected = new THREE.Vector3();

    /** Returns true when the view moved, so labels can keep pace with the canvas. */
    const updateDistanceFrame = () => {
      if (viewModeRef.current !== "map") {
        if (frameLabels.length) {
          frameLabels = [];
          return true;
        }
        return false;
      }
      const previous = frameLabels;
      frameLabels = distanceFrame.update({
        camera,
        yaw: controls.getMapYaw(),
        viewWidth: viewSize.w,
        viewHeight: viewSize.h,
      });
      return frameLabels !== previous;
    };

    const projectLabels = () => {
      if (viewSize.w <= 0 || viewSize.h <= 0) return;
      const activeCam = cameraRef.current || camera;
      const zoom =
        viewModeRef.current === "inspect"
          ? orbit.getCameraSize()
          : controls.getCameraSize();
      const candidates = [...labelStoreRef.current.values()]
        .filter((label) => (label.type === "contour" ? zoom <= CONTOUR_LABEL_MAX_ZOOM : true))
        .sort((a, b) => (LABEL_PRIORITY[a.type] ?? 9) - (LABEL_PRIORITY[b.type] ?? 9));

      // Frame labels are always kept; map labels route around them.
      const placed = [...frameLabels];
      let mapLabelCount = 0;

      for (const label of candidates) {
        if (mapLabelCount >= MAX_LABELS) break;

        projected.copy(label.position);
        mapRoot.localToWorld(projected);
        projected.project(activeCam);
        if (projected.x < -1 || projected.x > 1 || projected.y < -1 || projected.y > 1) {
          continue;
        }

        const offset = objectLabelOffsetPx(label, zoom, viewSize.h, {
          camera: activeCam,
          mapRoot,
          viewWidth: viewSize.w,
        });
        const x = ((projected.x + 1) / 2) * viewSize.w + offset.x;
        const y = ((1 - projected.y) / 2) * viewSize.h + offset.y;

        const collides = placed.some(
          (p) => Math.abs(p.x - x) < LABEL_MIN_GAP_PX && Math.abs(p.y - y) < LABEL_MIN_GAP_PX
        );
        if (collides) continue;

        mapLabelCount += 1;
        placed.push({
          id: label.id,
          type: label.type,
          title: label.title,
          detail: label.detail,
          objectType: label.objectType,
          color: label.color,
          x,
          y,
        });
      }

      setLabels(placed);
    };

    const updateXray = () => {
      const fusionLayer = fusionLayerRef.current;
      if (!fusionLayer) return;
      const mode = viewModeRef.current;
      const xrayOn = mode === "walk";
      fusionLayer.setPresentation?.({
        cones: mode === "inspect",
        rays: mode === "inspect",
        ghosts: xrayOn,
      });
      if (!xrayOn) {
        fusionLayer.hideGhosts();
        return;
      }
      fusionLayer.hideGhosts();
      const liveTracks = tracksRef.current || [];
      const shown = [];
      const camera = cameraRef.current;
      const raycaster = xrayRaycasterRef.current;
      for (const track of liveTracks) {
        const objectType = String(track.object_type || "").toLowerCase();
        if (!isObjectOfInterest(objectType)) continue;
        if (!track.observers?.length) continue;
        const pos = convertEnvPositionToThree(
          track.position,
          ENV_WIDTH,
          ENV_HEIGHT,
          THREE_WIDTH,
          THREE_HEIGHT
        );
        const height = visualHeightForType(objectType);
        if (!contactHiddenFromCamera(camera, mapRoot, raycaster, pos, height, track.name)) {
          continue;
        }
        const { width, depth } = footprintForTrack(track, mapData);
        fusionLayer.upsertGhost(track.name, pos, { objectType, width, depth, height });
        shown.push(track.name);
      }
      fusionLayer.pruneGhosts(shown);
    };

    const animate = () => {
      animRef.current = requestAnimationFrame(animate);
      walk.tick(performance.now());
      syncUserAvatar(
        walk,
        userMarkerRef.current,
        heightFieldRef.current,
        viewModeRef.current,
        labelStoreRef.current
      );
      selectionHighlightRef.current?.follow?.();
      const viewMoved = updateDistanceFrame();
      updateXray();
      pulseDetections(scene);
      renderer.render(scene, cameraRef.current || camera);

      const now = performance.now();
      if (viewMoved || now - lastLabelUpdate > 80) {
        lastLabelUpdate = now;
        projectLabels();
      }
    };
    animate();
    // Tracking the element (not a boolean) keeps pointer handlers bound to the
    // live canvas when the scene is torn down and rebuilt.
    setCanvasEl(renderer.domElement);

    return () => {
      setCanvasEl(null);
      cancelAnimationFrame(animRef.current);
      resizeObserver.disconnect();
      controls.dispose();
      orbit.dispose();
      walk.dispose();
      fusion.dispose();
      distanceFrame.dispose();
      distanceFrameRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      scene.traverse((obj) => {
        obj.userData?.disposeExtra?.();
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
      selectionHighlight.dispose();
      selectionHighlightRef.current = null;
      spawnMarkerRef.current = null;
      userMarkerRef.current = null;
      heightFieldRef.current = null;
      agentsRef.current = [];
      targetsRef.current = [];
      obstaclesRef.current = [];
      labelStoreRef.current = new Map();
      trackLayerRef.current = null;
      fusionLayerRef.current = null;
      mapRootRef.current = null;
      terrainRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      orthoCameraRef.current = null;
      perspCameraRef.current = null;
      orbitControlsRef.current = null;
      walkControlsRef.current = null;
      rendererRef.current = null;
      viewModeRef.current = "map";
      setViewMode("map");
      setLabels([]);
      setSelectedEntity(null);
      setHoverEntity(null);
      setMapYaw(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData]);

  // Pointer pick / hover
  useEffect(() => {
    const el = canvasEl;
    if (!el) return;

    const pick = (clientX, clientY) => {
      const rect = el.getBoundingClientRect();
      pointerRef.current.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current);
      const mapRoot = mapRootRef.current;
      if (!mapRoot) return null;
      const hits = raycasterRef.current.intersectObjects(mapRoot.children, true);
      const agentsById = new Map(agentsRef.current.map((a) => [String(a.id), a]));
      for (const hit of hits) {
        if (hit.object.userData?.kind === "fusion") continue;
        if (isUserMarker(hit.object)) continue;
        if (hit.object.userData?.kind === "spawn" || hit.object.parent?.userData?.kind === "spawn") {
          continue;
        }
        if (hit.object.userData?.kind === "editGizmo") continue;
        if (isRotateHandleObject(hit.object)) continue;
        if (hit.object.name === "selectionHighlight" || hit.object.parent?.name === "selectionHighlight") {
          continue;
        }
        const resolved = resolveEntityHit(hit.object, agentsById);
        if (resolved) return resolved;
      }
      return null;
    };

    const aimRay = (clientX, clientY) => {
      const rect = el.getBoundingClientRect();
      pointerRef.current.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current);
    };

    const pickRotateHandle = (clientX, clientY) => {
      const gizmo = selectionHighlightRef.current;
      if (!gizmo?.group?.visible) return false;
      aimRay(clientX, clientY);
      const hits = raycasterRef.current.intersectObject(gizmo.group, true);
      return hits.some((hit) => isRotateHandleObject(hit.object));
    };

    const selectHit = (hit) => {
      setSelectedEntity(hit?.entity ?? null);
      attachSelectionHighlight(
        selectionHighlightRef.current,
        hit?.root,
        hit?.entity,
        agentsRef.current,
        editModeRef.current
      );
    };

    const beginTransform = (mode, root, name, ground) => {
      const env = convertThreePositionToEnv(
        root.position,
        ENV_WIDTH,
        ENV_HEIGHT,
        THREE_WIDTH,
        THREE_HEIGHT
      );
      editTransformRef.current = {
        mode,
        name,
        root,
        grab: ground ? { x: ground.x - env.x, y: ground.y - env.y } : { x: 0, y: 0 },
        env: { x: env.x, y: env.y },
        heading: root.rotation.z || 0,
        dirty: false,
      };
      controlsRef.current?.setEnabled?.(false);
    };

    const applyTransform = (ground, { snap = false, force = false } = {}) => {
      const session = editTransformRef.current;
      if (!session || !ground || !session.root) return;
      if (session.mode === "rotate") {
        let heading = headingFromGround(ground, session.root);
        if (snap) {
          const step = Math.PI / 12;
          heading = Math.round(heading / step) * step;
        }
        session.root.rotation.z = heading;
        session.root.userData.heading = heading;
        session.heading = heading;
        session.dirty = true;
        const rotLabel =
          labelStoreRef.current.get(`map-${session.name}`) ||
          labelStoreRef.current.get(`detection-${session.name}`);
        if (rotLabel) rotLabel.heading = heading;
      } else {
        if (!force && !session.dirty) return;
        const x = ground.x - session.grab.x;
        const y = ground.y - session.grab.y;
        const pos = convertEnvPositionToThree(
          [x, y],
          ENV_WIDTH,
          ENV_HEIGHT,
          THREE_WIDTH,
          THREE_HEIGHT
        );
        session.root.position.x = pos.x;
        session.root.position.y = pos.y;
        seatMapObject(session.root, heightFieldRef.current, terrainScale(terrainRef.current));
        session.env = { x, y };
        session.dirty = true;
        const label =
          labelStoreRef.current.get(`map-${session.name}`) ||
          labelStoreRef.current.get(`detection-${session.name}`);
        if (label?.position) {
          label.position.set(
            session.root.position.x,
            session.root.position.y,
            labelWorldZ(session.root.position.z, session.root.userData?.object_type)
          );
        }
      }
      selectionHighlightRef.current?.follow?.();
    };

    const endTransform = () => {
      const session = editTransformRef.current;
      editTransformRef.current = null;
      if (!session) return false;
      controlsRef.current?.setEnabled?.(true);
      if (!session.dirty || !sessionId || !session.name) return Boolean(session.dirty);
      const body =
        session.mode === "rotate"
          ? { heading: session.heading }
          : { x: session.env.x, y: session.env.y };
      fetch(`/api/py/sessions/${sessionId}/objects/${encodeURIComponent(session.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => console.error("Failed to update object", err));
      return true;
    };

    const onMove = (e) => {
      const session = editTransformRef.current;
      if (session) {
        const ground = pickGroundEnv(
          el,
          e.clientX,
          e.clientY,
          cameraRef.current,
          terrainRef.current
        );
        if (session.mode === "move" && !session.dirty) {
          const dx = e.clientX - pointerDownRef.current.x;
          const dy = e.clientY - pointerDownRef.current.y;
          if (dx * dx + dy * dy <= 16) return;
        }
        applyTransform(ground, { snap: e.shiftKey, force: true });
        return;
      }
      const hit = pick(e.clientX, e.clientY);
      setHoverEntity(hit?.entity ?? null);
    };
    const onPointerDown = (e) => {
      pointerDownRef.current = { x: e.clientX, y: e.clientY };
      if (e.button !== 0) return;
      if (viewModeRef.current !== "map" || !editModeRef.current || placingSpawnRef.current) {
        return;
      }
      const ground = pickGroundEnv(
        el,
        e.clientX,
        e.clientY,
        cameraRef.current,
        terrainRef.current
      );
      if (pickRotateHandle(e.clientX, e.clientY)) {
        const root = selectionHighlightRef.current?.host?.();
        const name = root?.userData?.name || root?.name;
        if (root && name) {
          beginTransform("rotate", root, name, ground);
          e.stopPropagation();
          el.setPointerCapture?.(e.pointerId);
        }
        return;
      }
      const hit = pick(e.clientX, e.clientY);
      if (hit && (hit.entity.type === "map" || hit.entity.type === "detection")) {
        selectHit(hit);
        beginTransform("move", hit.root, hit.entity.id, ground);
        e.stopPropagation();
        el.setPointerCapture?.(e.pointerId);
      }
    };
    const onPointerUp = (e) => {
      if (editTransformRef.current) {
        el.releasePointerCapture?.(e.pointerId);
        endTransform();
      }
    };
    const onClick = (e) => {
      if (editTransformRef.current) return;
      const dx = e.clientX - pointerDownRef.current.x;
      const dy = e.clientY - pointerDownRef.current.y;
      if (dx * dx + dy * dy > 16) return;
      if (placingSpawnRef.current) {
        const ground = pickGroundEnv(
          el,
          e.clientX,
          e.clientY,
          cameraRef.current,
          terrainRef.current
        );
        if (ground && sessionId) {
          fetch(`/api/py/sessions/${sessionId}/spawn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ x: ground.x, y: ground.y }),
          }).catch((err) => console.error("Failed to set spawn", err));
        }
        placingSpawnRef.current = false;
        setPlacingSpawn(false);
        return;
      }
      if (editModeRef.current) {
        if (pickRotateHandle(e.clientX, e.clientY)) return;
        const hit = pick(e.clientX, e.clientY);
        if (!hit) {
          setSelectedEntity(null);
          selectionHighlightRef.current?.clear();
        }
        return;
      }
      const hit = pick(e.clientX, e.clientY);
      selectHit(hit);
    };

    const onDragOver = (e) => {
      if (e.dataTransfer?.types?.includes("application/x-vanguard-stamp")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (e) => {
      const type = e.dataTransfer.getData("application/x-vanguard-stamp");
      if (!type || viewModeRef.current !== "map" || !editModeRef.current) return;
      e.preventDefault();
      const ground = pickGroundEnv(
        el,
        e.clientX,
        e.clientY,
        cameraRef.current,
        terrainRef.current
      );
      if (ground && sessionId) {
        fetch(`/api/py/sessions/${sessionId}/objects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ object_type: type, x: ground.x, y: ground.y }),
        })
          .then((res) => res.json())
          .then((data) => {
            const obj = data?.object;
            if (!obj?.name) return;
            setSelectedEntity({
              type: "map",
              id: obj.name,
              objectType: obj.object_type,
              heading: obj.heading,
              envX: obj.position?.[0],
              envY: obj.position?.[1],
            });
          })
          .catch((err) => console.error("Failed to place object", err));
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("click", onClick);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("click", onClick);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      if (editTransformRef.current) {
        editTransformRef.current = null;
        controlsRef.current?.setEnabled?.(true);
      }
    };
  }, [canvasEl, sessionId]);

  useEffect(() => {
    const rotateSelected = (delta) => {
      const name = selectedEntity?.id;
      if (!name || !sessionId || !editMode) return;
      if (selectedEntity.type !== "map" && selectedEntity.type !== "detection") return;
      const root = findEntityRootByReadout(selectedEntity, {
        agents: agentsRef.current,
        targets: targetsRef.current,
        obstacles: obstaclesRef.current,
        mapRoot: mapRootRef.current,
      });
      const heading = (root?.rotation.z || 0) + delta;
      if (root) {
        root.rotation.z = heading;
        root.userData.heading = heading;
        selectionHighlightRef.current?.follow?.();
      }
      fetch(`/api/py/sessions/${sessionId}/objects/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heading }),
      }).catch((err) => console.error("Failed to rotate object", err));
    };
    const onKey = (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if ((e.key === "q" || e.key === "Q") && editMode) {
        e.preventDefault();
        rotateSelected(-Math.PI / 12);
        return;
      }
      if ((e.key === "e" || e.key === "E") && editMode) {
        e.preventDefault();
        rotateSelected(Math.PI / 12);
        return;
      }
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const name = selectedEntity?.id;
      if (!name || !sessionId || !editMode) return;
      if (selectedEntity.type !== "map" && selectedEntity.type !== "detection") return;
      e.preventDefault();
      fetch(`/api/py/sessions/${sessionId}/objects/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }).catch((err) => console.error("Failed to delete object", err));
      selectionHighlightRef.current?.clear();
      setSelectedEntity(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEntity, sessionId, editMode]);

  // Sync websocket entities
  useEffect(() => {
    const mapRoot = mapRootRef.current;
    if (!mapRoot || !canvasEl) return;
    const tracks = trackLayerRef.current;
    tracksRef.current = Array.isArray(fusedTracks) ? fusedTracks : [];
    if (Array.isArray(liveMapObjects)) {
      syncWorldObjects(
        mapRoot,
        liveMapObjects,
        labelStoreRef.current,
        heightFieldRef.current,
        terrainScale(terrainRef.current),
        editMode,
        editTransformRef.current?.name
      );
    }
    const fusionLayer = fusionLayerRef.current;
    if (spawnMarkerRef.current && Array.isArray(spawn) && spawn.length >= 2) {
      const pos = convertEnvPositionToThree(
        spawn,
        ENV_WIDTH,
        ENV_HEIGHT,
        THREE_WIDTH,
        THREE_HEIGHT
      );
      const surface = surfaceZAtThree(
        heightFieldRef.current,
        pos.x,
        pos.y,
        { zScale: terrainScale(terrainRef.current) }
      );
      const deck = (Number.isFinite(surface) ? surface : 0) + 0.02;
      spawnMarkerRef.current.position.set(pos.x, pos.y, deck);
      labelStoreRef.current.set("spawn", {
        id: "spawn",
        type: "map",
        title: "Spawn",
        objectType: "spawn",
        footprint: [20, 20],
        position: new THREE.Vector3(pos.x, pos.y, deck + 0.18),
      });
    }

    Object.entries(targets || {}).forEach(([id, targetData]) => {
      const { position, radius } = targetData;
      const pos = convertEnvPositionToThree(
        position,
        ENV_WIDTH,
        ENV_HEIGHT,
        THREE_WIDTH,
        THREE_HEIGHT
      );
      let target = targetsRef.current.find((t) => String(t.id) === String(id));
      if (!target) {
        target = new Target(
          id,
          pos,
          convertEnvRadiusToThree(radius, ENV_WIDTH, ENV_HEIGHT, THREE_WIDTH, THREE_HEIGHT),
          TAC.target
        );
        mapRoot.add(target.mesh);
        targetsRef.current.push(target);
      } else {
        target.position.copy(pos);
        target.updateMeshPosition();
      }
    });

    Object.entries(obstacles || {}).forEach(([id, obstacleData]) => {
      const { position, radius } = obstacleData;
      const pos = convertEnvPositionToThree(
        position,
        ENV_WIDTH,
        ENV_HEIGHT,
        THREE_WIDTH,
        THREE_HEIGHT
      );
      let obstacle = obstaclesRef.current.find((o) => String(o.id) === String(id));
      if (!obstacle) {
        obstacle = new Obstacle(
          id,
          pos,
          convertEnvRadiusToThree(radius, ENV_WIDTH, ENV_HEIGHT, THREE_WIDTH, THREE_HEIGHT),
          TAC.obstacle
        );
        mapRoot.add(obstacle.mesh);
        obstaclesRef.current.push(obstacle);
      } else {
        obstacle.position.copy(pos);
        obstacle.updateMeshPosition();
      }
    });

    const activeAgentIds = [];

    Object.entries(agents || {}).forEach(([id, agentData]) => {
      activeAgentIds.push(id);
      const { target_id, position, z_position = 0, velocity, acceleration } = agentData;
      const pos = convertEnvPositionToThree(
        position,
        ENV_WIDTH,
        ENV_HEIGHT,
        THREE_WIDTH,
        THREE_HEIGHT,
        z_position
      );
      const agl = seatDroneAboveTerrain(pos, heightFieldRef.current, terrainRef.current);
      let agent = agentsRef.current.find((b) => String(b.id) === String(id));
      const color = getColorBySwarmId(target_id);

      if (!agent) {
        agent = new Agent(id, target_id, pos, agl, velocity, acceleration, color);
        const indicators = attachIndicatorsToAgent(agent, {
          boundingBox: selectedIndicator === "box",
          crosshair: selectedIndicator === "crosshair",
          detectionRadius: selectedIndicator === "radius",
        });
        agent.indicators = indicators;
        mapRoot.add(agent.mesh);
        mapRoot.add(indicators);
        agentsRef.current.push(agent);
        indicatorTypeRef.current = selectedIndicator;
      } else {
        agent.position.copy(pos);
        agent.stemLength = agl;
        agent.setVelocity(velocity);
        agent.setTargetId(target_id);
        agent.updateMeshPosition();
        agent.updateColor(color);

        if (selectedIndicator !== indicatorTypeRef.current) {
          if (agent.indicators) mapRoot.remove(agent.indicators);
          const indicators = attachIndicatorsToAgent(agent, {
            boundingBox: selectedIndicator === "box",
            crosshair: selectedIndicator === "crosshair",
            detectionRadius: selectedIndicator === "radius",
          });
          agent.indicators = indicators;
          mapRoot.add(indicators);
        } else {
          updateAgentIndicators(agent);
        }
      }

      if (tracks) {
        tracks.pushTrail(id, agent.position);
        tracks.updateVelocity(id, agent.position, agent.velocity);
        const assigned = targetsRef.current.find(
          (t) => String(t.id) === String(target_id)
        );
        tracks.updateLink(id, agent.position, assigned?.position);
      }
    });

    if (selectedIndicator !== indicatorTypeRef.current) {
      indicatorTypeRef.current = selectedIndicator;
    }

    tracks?.prune(activeAgentIds);

    if (fusionLayer) {
      const mode = viewModeRef.current;
      fusionLayer.setPresentation?.({
        cones: mode === "inspect",
        rays: mode === "inspect",
        ghosts: mode === "walk",
      });
      Object.entries(agents || {}).forEach(([id, agentData]) => {
        const agent = agentsRef.current.find((a) => String(a.id) === String(id));
        if (!agent) return;
        fusionLayer.upsertCone(
          id,
          agent.position,
          getColorBySwarmId(agentData.target_id),
          surfaceZAtThree(heightFieldRef.current, agent.position.x, agent.position.y)
        );
      });
      fusionLayer.pruneCones(activeAgentIds);
      const segments = [];
      (fusedTracks || []).forEach((track) => {
        const to = convertEnvPositionToThree(
          track.position,
          ENV_WIDTH,
          ENV_HEIGHT,
          THREE_WIDTH,
          THREE_HEIGHT,
          track.z
        );
        (track.observers || []).forEach((aid) => {
          const observer = agentsRef.current.find((a) => String(a.id) === String(aid));
          if (observer) segments.push({ from: observer.position, to });
        });
      });
      fusionLayer.setRays(viewModeRef.current === "inspect" ? segments : []);
    }

    const revealed = new Map();
    (fusedTracks || []).forEach((track) => {
      if (track?.name) revealed.set(track.name, track);
    });
    (new_detections || []).forEach((detection) => {
      if (detection?.name) revealed.set(detection.name, detection);
    });
    if (revealed.size) {
      updateDetections(
        mapRoot,
        [...revealed.values()],
        labelStoreRef.current,
        mapData
      );
    }

    // Keep the fixed inspector in sync as selected / hovered entities move.
    setSelectedEntity((prev) => {
      const next = refreshEntityReadout(prev, {
        agents: agentsRef.current,
        targets: targetsRef.current,
        obstacles: obstaclesRef.current,
        mapRoot,
      });
      // Re-bind outline only if the host mesh was recreated.
      if (next) {
        const root = findEntityRootByReadout(next, {
          agents: agentsRef.current,
          targets: targetsRef.current,
          obstacles: obstaclesRef.current,
          mapRoot,
        });
        const highlight = selectionHighlightRef.current;
        if (root && highlight && highlight.host?.() !== root) {
          attachSelectionHighlight(
            highlight,
            root,
            next,
            agentsRef.current,
            editModeRef.current
          );
        } else if (root && highlight) {
          highlight.setEdit?.(
            editMode && (next.type === "map" || next.type === "detection")
          );
          highlight.follow?.();
        }
      }
      return next;
    });
    setHoverEntity((prev) =>
      refreshEntityReadout(prev, {
        agents: agentsRef.current,
        targets: targetsRef.current,
        obstacles: obstaclesRef.current,
        mapRoot,
      })
    );
  }, [agents, targets, obstacles, new_detections, fusedTracks, spawn, liveMapObjects, mapData, selectedIndicator, canvasEl, editMode]);

  const cursorMode =
    dragMode ||
    (placingSpawn
      ? "spawn"
      : viewMode === "inspect"
        ? "orbit"
        : viewMode === "walk"
          ? "walk"
          : interactionMode);
  const cursorClass =
    cursorMode === "spawn"
      ? "map-cursor-spawn"
      : cursorMode === "rotate" || cursorMode === "orbit" || cursorMode === "look"
        ? dragMode
          ? "map-cursor-rotate-active"
          : "map-cursor-rotate"
        : dragMode
          ? "map-cursor-pan-active"
          : "map-cursor-pan";

  return (
    <div className="relative h-full w-full overflow-hidden bg-tac-bg">
      <div ref={containerRef} className={`absolute inset-0 ${cursorClass}`} />
      <SceneLabels labels={labels} reticleIntensity={reticleIntensity} />
      <SceneHUD
        mapYaw={mapYaw}
        interactionMode={interactionMode}
        viewMode={viewMode}
        reticleIntensity={reticleIntensity}
        selectedEntity={selectedEntity}
        hoverEntity={hoverEntity}
        onResetYaw={handleResetYaw}
        onInteractionModeChange={handleInteractionModeChange}
        onViewModeChange={handleViewModeChange}
        onReticleIntensityChange={handleReticleIntensityChange}
        placingSpawn={placingSpawn}
        onPlacingSpawnChange={(next) => {
          placingSpawnRef.current = next;
          setPlacingSpawn(next);
          if (next) {
            stampTypeRef.current = null;
            setStampType(null);
          }
        }}
        editMode={editMode}
        onEditModeChange={(next) => {
          editModeRef.current = next;
          setEditMode(next);
          if (!next) {
            stampTypeRef.current = null;
            setStampType(null);
            selectionHighlightRef.current?.clear();
            setSelectedEntity(null);
          } else {
            placingSpawnRef.current = false;
            setPlacingSpawn(false);
            if (selectedEntity) {
              const root = findEntityRootByReadout(selectedEntity, {
                agents: agentsRef.current,
                targets: targetsRef.current,
                obstacles: obstaclesRef.current,
                mapRoot: mapRootRef.current,
              });
              attachSelectionHighlight(
                selectionHighlightRef.current,
                root,
                selectedEntity,
                agentsRef.current,
                true
              );
            }
          }
        }}
        stampType={stampType}
        onStampTypeChange={(next) => {
          if (!editModeRef.current) return;
          stampTypeRef.current = next;
          setStampType(next);
          if (next) {
            placingSpawnRef.current = false;
            setPlacingSpawn(false);
          }
        }}
        onRotateSelected={(delta) => {
          const name = selectedEntity?.id;
          if (!name || !sessionId || !editMode) return;
          if (selectedEntity.type !== "map" && selectedEntity.type !== "detection") return;
          const root = findEntityRootByReadout(selectedEntity, {
            agents: agentsRef.current,
            targets: targetsRef.current,
            obstacles: obstaclesRef.current,
            mapRoot: mapRootRef.current,
          });
          const heading = (root?.rotation.z || 0) + delta;
          if (root) {
            root.rotation.z = heading;
            root.userData.heading = heading;
            selectionHighlightRef.current?.follow?.();
          }
          fetch(`/api/py/sessions/${sessionId}/objects/${encodeURIComponent(name)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ heading }),
          }).catch((err) => console.error("Failed to rotate object", err));
        }}
        onDeleteSelected={() => {
          const name = selectedEntity?.id;
          if (!name || !sessionId || !editMode) return;
          if (selectedEntity.type !== "map" && selectedEntity.type !== "detection") return;
          fetch(`/api/py/sessions/${sessionId}/objects/${encodeURIComponent(name)}`, {
            method: "DELETE",
          }).catch((err) => console.error("Failed to delete object", err));
          selectionHighlightRef.current?.clear();
          setSelectedEntity(null);
        }}
        onClearSelection={() => {
          selectionHighlightRef.current?.clear();
          setSelectedEntity(null);
        }}
      />
    </div>
  );
};

export default ThreeScene;
