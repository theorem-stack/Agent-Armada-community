
const TERRAIN_HEIGHT_MAP = [
    [0, 0, 0, 0, 6],
    [2, 4, 0, 0, 0],
    [2, 0, 8, 0, 0],
    [0, 0, 0, 2, 0],
    [6, 0, 4, 4, 4]
];

const TERRAIN_MAP_SCALE = 1; // Level of detail
const ENV_WIDTH = 800;   // Environment width
const ENV_HEIGHT = 600;  // Environment height
const THREE_WIDTH = 10;     // Define the width of your Three.js scene
const THREE_HEIGHT = 7.5;   // Define the height of your Three.js scene
/** Env meters per Three.js world unit — uniform X/Y/Z. */
const WORLD_SCALE = THREE_WIDTH / ENV_WIDTH;
/** Alias: drone altitude and sensor range use the same scale as footprints. */
const ALTITUDE_SCALE = WORLD_SCALE;
/** Keep in sync with api/config.py SENSOR_*. */
const SENSOR_RANGE = 100;
const SENSOR_HALF_ANGLE = 50;
/** Known COP at spawn — keep in sync with api/config.py START_DETECTED_TYPES. */
const START_DETECTED_TYPES = ["building", "flood", "tree", "container"];
/** Detected types that get walk X-ray when occluded — keep in sync with api/config.py. */
const OBJECTS_OF_INTEREST = ["person"];
/** Editor stamps — keep in sync with api/config.py OBJECT_CATALOG. */
const OBJECT_CATALOG = [
  { object_type: "building", label: "Building", footprint: [20, 20] },
  { object_type: "tree", label: "Tree", footprint: [20, 20] },
  { object_type: "container", label: "Container", footprint: [64, 24] },
  { object_type: "person", label: "Person", footprint: [20, 20] },
  { object_type: "vehicle", label: "Vehicle", footprint: [20, 20] },
  { object_type: "flood", label: "Flood", footprint: [80, 80] },
];

function isObjectOfInterest(objectType) {
  return OBJECTS_OF_INTEREST.includes(String(objectType || "").toLowerCase());
}
/** Env-unit object heights — keep in sync with api/config.py OBJECT_HEIGHTS. */
const OBJECT_HEIGHTS = {
  tree: 28,
  building: 22,
  container: 16,
  person: 2,
  vehicle: 2,
};
/**
 * Mesh XY in env meters when the COP stamp is an icon, not a body.
 * Buildings / trees / containers / flood use the authored footprint.
 */
const VISUAL_BODY_METERS = {
  person: [0.8, 0.8],
  vehicle: [4.8, 1.9],
};

function envToWorld(meters) {
  return Number(meters) * WORLD_SCALE;
}

function footprintToWorld(envFootprint = [0, 0]) {
  return [envToWorld(envFootprint[0] || 0), envToWorld(envFootprint[1] || 0)];
}

function visualHeightForType(objectType) {
  const envH = OBJECT_HEIGHTS[objectType] ?? 2;
  return envToWorld(envH);
}

function visualFootprint(objectType, envFootprint = [20, 20]) {
  const body = VISUAL_BODY_METERS[String(objectType || "").toLowerCase()];
  if (body) return footprintToWorld(body);
  return footprintToWorld(envFootprint);
}

export {
  TERRAIN_HEIGHT_MAP,
  TERRAIN_MAP_SCALE,
  ENV_WIDTH,
  ENV_HEIGHT,
  THREE_WIDTH,
  THREE_HEIGHT,
  WORLD_SCALE,
  ALTITUDE_SCALE,
  SENSOR_RANGE,
  SENSOR_HALF_ANGLE,
  OBJECT_HEIGHTS,
  VISUAL_BODY_METERS,
  START_DETECTED_TYPES,
  OBJECTS_OF_INTEREST,
  OBJECT_CATALOG,
  envToWorld,
  footprintToWorld,
  visualHeightForType,
  visualFootprint,
  isObjectOfInterest,
};
