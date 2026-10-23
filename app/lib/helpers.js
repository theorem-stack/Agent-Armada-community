import * as THREE from "three";
import {
  ENV_WIDTH,
  ENV_HEIGHT,
  THREE_WIDTH,
  THREE_HEIGHT,
  ALTITUDE_SCALE,
  envToWorld,
  visualHeightForType,
  visualFootprint,
  footprintToWorld,
  START_DETECTED_TYPES,
} from "../data/globalVars";
import { surfaceZAtThree } from "../components/visuals/heightField";
import { getColorBySwarmId } from "../components/visuals/palette";
import {
  mapObjectMaterial,
  createBuildingMarker,
  createPersonMarker,
  createTreeMarker,
  createContainerMarker,
  createDetectionMarker,
  detectionColorForType,
  updateDetectionPulse,
} from "../components/visuals/tacticalMarkers";

const createRefinedHeightMapTexture = (heightMap, scaleFactor, geometryWidth, geometryHeight) => {
  const scaledMap = scaleHeightMap(heightMap, geometryWidth, geometryHeight);
  const originalWidth = scaledMap[0].length;
  const originalHeight = scaledMap.length;
  const width = originalWidth * scaleFactor;
  const height = originalHeight * scaleFactor;

  const refinedHeightMap = new Array(height);
  for (let y = 0; y < height; y++) {
    refinedHeightMap[y] = new Array(width);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = x / scaleFactor;
      const srcY = y / scaleFactor;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, originalWidth - 1);
      const y0 = Math.floor(srcY);
      const y1 = Math.min(y0 + 1, originalHeight - 1);
      const q11 = scaledMap[y0][x0];
      const q12 = scaledMap[y1][x0];
      const q21 = scaledMap[y0][x1];
      const q22 = scaledMap[y1][x1];
      const fX1 = q11 * (x1 - srcX) + q21 * (srcX - x0);
      const fX2 = q12 * (x1 - srcX) + q22 * (srcX - x0);
      refinedHeightMap[y][x] = fX1 * (y1 - srcY) + fX2 * (srcY - y0);
    }
  }

  const data = new Uint8Array(width * height * 4);
  let max_height = -Infinity;
  let min_height = Infinity;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = refinedHeightMap[y][x];
      if (value > max_height) max_height = value;
      if (value < min_height) min_height = value;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = refinedHeightMap[y][x];
      const normalizedHeight = (value - min_height) / (max_height - min_height || 1);
      const colorValue = Math.round(255 * (1 - normalizedHeight));
      const index = (x + y * width) * 4;
      data[index] = colorValue;
      data[index + 1] = colorValue;
      data[index + 2] = colorValue;
      data[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
};

const scaleHeightMap = (heightMap, geometryWidth, geometryHeight) => {
  const originalWidth = heightMap[0].length;
  const originalHeight = heightMap.length;
  const refinedHeightMap = new Array(geometryHeight);
  for (let i = 0; i < geometryHeight; i++) {
    refinedHeightMap[i] = new Array(geometryWidth);
  }

  const xScale = originalWidth / geometryWidth;
  const yScale = originalHeight / geometryHeight;

  for (let y = 0; y < geometryHeight; y++) {
    for (let x = 0; x < geometryWidth; x++) {
      const originalX = x * xScale;
      const originalY = y * yScale;
      const x0 = Math.floor(originalX);
      const x1 = Math.min(x0 + 1, originalWidth - 1);
      const y0 = Math.floor(originalY);
      const y1 = Math.min(y0 + 1, originalHeight - 1);
      const xFraction = originalX - x0;
      const yFraction = originalY - y0;
      const top = (1 - xFraction) * heightMap[y0][x0] + xFraction * heightMap[y0][x1];
      const bottom = (1 - xFraction) * heightMap[y1][x0] + xFraction * heightMap[y1][x1];
      refinedHeightMap[y][x] = (1 - yFraction) * top + yFraction * bottom;
    }
  }

  return refinedHeightMap;
};

function envScaleFactors(envWidth, envHeight, threeWidth, threeHeight) {
  const aspectRatioEnv = envWidth / envHeight;
  const aspectRatioThree = threeWidth / threeHeight;
  if (aspectRatioEnv > aspectRatioThree) {
    const scaleX = threeWidth / envWidth;
    return { scaleX, scaleY: scaleX };
  }
  const scaleY = threeHeight / envHeight;
  return { scaleX: scaleY, scaleY };
}

function convertEnvPositionToThree(
  position,
  envWidth,
  envHeight,
  threeWidth,
  threeHeight,
  altitude = 0
) {
  const { scaleX, scaleY } = envScaleFactors(envWidth, envHeight, threeWidth, threeHeight);
  const x = (position[0] - envWidth / 2) * scaleX;
  const y = (position[1] - envHeight / 2) * scaleY;
  const z = (altitude ?? 0) * ALTITUDE_SCALE;
  return new THREE.Vector3(x, y, z);
}

/** Inverse of convertEnvPositionToThree — returns { x, y, alt } in env units. */
function convertThreePositionToEnv(
  position,
  envWidth,
  envHeight,
  threeWidth,
  threeHeight
) {
  const { scaleX, scaleY } = envScaleFactors(envWidth, envHeight, threeWidth, threeHeight);
  return {
    x: position.x / scaleX + envWidth / 2,
    y: position.y / scaleY + envHeight / 2,
    alt: (position.z ?? 0) / ALTITUDE_SCALE,
  };
}

function convertEnvRadiusToThree(envRadius, envWidth, envHeight, threeWidth, threeHeight) {
  const aspectRatioEnv = envWidth / envHeight;
  const aspectRatioThree = threeWidth / threeHeight;
  let scale;
  if (aspectRatioEnv > aspectRatioThree) {
    scale = threeWidth / envWidth;
  } else {
    scale = threeHeight / envHeight;
  }
  return envRadius * scale;
}

/** Env units represented by one Three.js world unit along X */
function envUnitsPerThreeUnit(envWidth, envHeight, threeWidth, threeHeight) {
  const aspectRatioEnv = envWidth / envHeight;
  const aspectRatioThree = threeWidth / threeHeight;
  if (aspectRatioEnv > aspectRatioThree) {
    return envWidth / threeWidth;
  }
  return envHeight / threeHeight;
}

const SHORT_MAP_ALIASES = {
  "shipping container": "Container",
  "flooded area": "Flood",
  "fallen tree": "Tree",
  "open field": "Field",
};

function shortMapLabel(name, objectType) {
  const type = String(objectType || "").toLowerCase();
  if (type === "spawn") return "Spawn";
  const raw = String(name || "").trim();
  return SHORT_MAP_ALIASES[raw.toLowerCase()] || raw || "Object";
}

function shouldShowMapObject(mapObject, { editMode = false } = {}) {
  if (!mapObject) return false;
  if (editMode) return true;
  if (mapObject.detected === true) return true;
  const type = String(mapObject.object_type || "").toLowerCase();
  return mapObject.detected == null && START_DETECTED_TYPES.includes(type);
}

function seatOffsetForType(objectType, visualH) {
  if (objectType === "vehicle") return visualH / 2;
  if (objectType === "flood") return envToWorld(0.4);
  return 0;
}

function labelWorldZ(meshZ, objectType) {
  return (meshZ || 0) + visualHeightForType(objectType) + envToWorld(2);
}

function seatMapObject(mesh, field, zScale = 1) {
  if (!mesh) return;
  const surface = surfaceZAtThree(field, mesh.position.x, mesh.position.y, { zScale });
  const offset = mesh.userData?.seatOffset ?? 0;
  mesh.position.z = surface + offset;
}

function createMapObjects(mapObjects, scene, labelStore, field, zScale = 1, editMode = false) {
  if (!mapObjects || !Array.isArray(mapObjects)) return;

  mapObjects.forEach((mapObject) => {
    const { name, position, boundingBox, object_type, condition, properties, detected, authored, heading, footprint } = mapObject;
    if (!shouldShowMapObject({ detected, authored, object_type }, { editMode })) return;

    const threePosition = convertEnvPositionToThree(
      position,
      ENV_WIDTH,
      ENV_HEIGHT,
      THREE_WIDTH,
      THREE_HEIGHT
    );

    const [[BL_x, BL_y], [TR_x, TR_y]] = boundingBox;
    const width = footprint?.[0] ?? TR_x - BL_x;
    const height = footprint?.[1] ?? TR_y - BL_y;
    const [stampW, stampD] = footprintToWorld([width, height]);
    const [meshW, meshD] = visualFootprint(object_type, [width, height]);

    let mesh;

    const visualH = visualHeightForType(object_type);

    switch (object_type) {
      case "building":
        mesh = createBuildingMarker(meshW, meshD, condition, visualH);
        break;
      case "flood":
        mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(stampW, stampD),
          mapObjectMaterial(object_type, condition)
        );
        mesh.position.z = envToWorld(0.4);
        break;
      case "tree":
        mesh = createTreeMarker(meshW, meshD, visualH);
        break;
      case "container":
        mesh = createContainerMarker(meshW, meshD, visualH);
        break;
      case "vehicle":
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(meshW, meshD, visualH),
          mapObjectMaterial(object_type, condition)
        );
        mesh.position.z = visualH / 2;
        break;
      case "person":
        mesh = createPersonMarker(
          Math.max(meshW, meshD) / 2,
          visualH,
          detectionColorForType(object_type)
        );
        break;
      default:
        console.warn(`Unknown object type: ${object_type}`);
        return;
    }

    mesh.position.x = threePosition.x;
    mesh.position.y = threePosition.y;
    mesh.rotation.z = Number(heading) || 0;
    mesh.name = name;
    mesh.userData = {
      ...mesh.userData,
      name,
      boundingBox,
      condition,
      properties,
      entityType: "mapObject",
      object_type,
      authored: Boolean(authored),
      worldObject: true,
      heading: Number(heading) || 0,
      footprint: [width, height],
      seatOffset: seatOffsetForType(object_type, visualH),
    };
    if (object_type === "flood") {
      mesh.position.z = mesh.userData.seatOffset;
    }
    scene.add(mesh);
    seatMapObject(mesh, field, zScale);

    labelStore?.set(`map-${name}`, {
      id: `map-${name}`,
      type: "map",
      title: shortMapLabel(name, object_type),
      objectType: object_type,
      footprint: [width, height],
      heading: Number(heading) || 0,
      position: new THREE.Vector3(
        mesh.position.x,
        mesh.position.y,
        labelWorldZ(mesh.position.z, object_type)
      ),
    });
  });
}

function resolveDetection(detection, mapObjects) {
  const mapped = Array.isArray(mapObjects)
    ? mapObjects.find((obj) => obj.name === detection.name)
    : null;
  const name = detection.name;
  const position = detection.position || mapped?.position;
  const boundingBox = detection.boundingBox || mapped?.boundingBox;
  const object_type = detection.object_type || mapped?.object_type;
  const condition = detection.condition ?? mapped?.condition;
  const properties = detection.properties ?? mapped?.properties;
  if (!name || !position || !boundingBox || !object_type) return null;
  return { name, position, boundingBox, object_type, condition, properties };
}

const updateDetections = (scene, detections, labelStore, mapObjects) => {
  if (!detections || !detections.length) return;

  detections.forEach((raw) => {
    const detection = resolveDetection(raw, mapObjects);
    if (!detection) return;
    const { name, position, boundingBox, object_type, condition, properties } = detection;
    const pos = convertEnvPositionToThree(
      position,
      ENV_WIDTH,
      ENV_HEIGHT,
      THREE_WIDTH,
      THREE_HEIGHT
    );

    let existing = scene.getObjectByName(name);
    if (existing) {
      existing.position.set(pos.x, pos.y, existing.position.z);
      return;
    }

    const envW = boundingBox[1][0] - boundingBox[0][0];
    const envD = boundingBox[1][1] - boundingBox[0][1];
    const [meshW, meshD] = visualFootprint(object_type, [envW, envD]);
    const [stampW, stampD] = footprintToWorld([envW, envD]);

    const visualH = visualHeightForType(object_type);
    const group = createDetectionMarker(
      meshW,
      meshD,
      object_type,
      condition,
      visualH,
      { halo: Math.max(stampW, stampD) * 0.5 }
    );
    group.name = name;
    group.position.set(pos.x, pos.y, 0);
    group.userData.entityType = "detection";
    group.userData.object_type = object_type;
    group.userData.id = name;
    group.userData.worldObject = true;
    group.userData.seatOffset = seatOffsetForType(object_type, visualH);
    scene.add(group);

    labelStore?.set(`detection-${name}`, {
      id: `detection-${name}`,
      type: "detection",
      title: shortMapLabel(name, object_type),
      objectType: object_type,
      footprint: [envW, envD],
      heading: Number(detection.heading) || 0,
      position: new THREE.Vector3(pos.x, pos.y, labelWorldZ(0, object_type)),
    });
  });
};

function pulseDetections(scene) {
  scene.traverse((obj) => {
    if (obj.userData?.kind === "detection" || obj.userData?.entityType === "detection") {
      updateDetectionPulse(obj);
    }
  });
}

export {
  createRefinedHeightMapTexture,
  convertEnvPositionToThree,
  convertThreePositionToEnv,
  getColorBySwarmId,
  convertEnvRadiusToThree,
  createMapObjects,
  shouldShowMapObject,
  seatMapObject,
  updateDetections,
  pulseDetections,
  envUnitsPerThreeUnit,
  shortMapLabel,
  labelWorldZ,
};
