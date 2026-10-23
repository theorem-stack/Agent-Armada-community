/** Modern tactical COP palette — cool arctic ops console */

export const TAC = {
  paper: 0xf1f3f5,
  sceneBg: 0xdce1e6,
  backdrop: 0xd4d9de,
  /** Cool slate used for frosted off-AOI frame */
  void: 0xb8c0c8,
  gridMinor: 0xd0d6dc,
  gridMajor: 0xb8c0c8,
  aoi: 0x0c7c93,
  aoiCorner: 0x0a5f72,
  range: 0x14a3b8,
  agentStem: 0x7a8d9a,
  target: 0xc4892a,
  spawn: 0x0c7c93,
  obstacle: 0x6e7d8a,
  detection: 0x0c7c93,
  flood: 0x3d8fb0,
  buildingOk: 0x3d4a55,
  buildingDamaged: 0xc23d32,
  buildingStroke: 0xf4f7fa,
  buildingInk: 0x152028,
  vehicle: 0x5a6d7c,
  person: 0xc4892a,
  user: 0x7c5cfc,
  tree: 0x6f8574,
  container: 0xd45a14,
  containerRib: 0x8a3a0c,
  containerFrame: 0x2a211c,
  velocity: 0x0c7c93,
  trail: 0x8ea5b5,
  link: 0xa8b8c4,
  crosshair: 0xc23d32,
  box: 0x0c7c93,
  radius: 0xc4892a,
  xray: 0x14c4d4,
  cone: 0x14a3b8,
  /** Fallback when a single contour tint is needed */
  contourMinor: 0x7a9aab,
  contourIndex: 0xb8894a,
};

/**
 * Contour-line ramp (more saturated than the faint paper terrain).
 * Low = cool slate-teal → mid stone → high warm ochre.
 */
const CONTOUR_STOPS = [
  { t: 0.0, r: 0x5a, g: 0x8a, b: 0x9e },
  { t: 0.35, r: 0x6e, g: 0x8f, b: 0x7a },
  { t: 0.65, r: 0xb0, g: 0x96, b: 0x5a },
  { t: 1.0, r: 0xc0, g: 0x78, b: 0x48 },
];

/** @returns {{ r:number, g:number, b:number }} 0–1 channels */
export function contourColor(t) {
  const clamped = Math.min(1, Math.max(0, t));
  let lo = CONTOUR_STOPS[0];
  let hi = CONTOUR_STOPS[CONTOUR_STOPS.length - 1];

  for (let i = 0; i < CONTOUR_STOPS.length - 1; i++) {
    if (clamped >= CONTOUR_STOPS[i].t && clamped <= CONTOUR_STOPS[i + 1].t) {
      lo = CONTOUR_STOPS[i];
      hi = CONTOUR_STOPS[i + 1];
      break;
    }
  }

  const span = hi.t - lo.t || 1;
  const u = (clamped - lo.t) / span;
  return {
    r: (lo.r + (hi.r - lo.r) * u) / 255,
    g: (lo.g + (hi.g - lo.g) * u) / 255,
    b: (lo.b + (hi.b - lo.b) * u) / 255,
  };
}

/** CSS hex for DOM contour elevation tags */
export function contourColorHex(t) {
  const c = contourColor(t);
  const to = (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

/** Role/swarm accents — distinct on cool slate, no green/purple dominance */
const SWARM_COLORS = [
  0x0c7c93, // ops teal
  0xc4892a, // amber
  0x3d6f9a, // steel
  0xb85a3d, // copper
  0x5a6d7c, // slate
  0x2a8f7a, // sea green
  0xc23d32, // signal red
  0x4a7fa8, // ice blue
];

export function getColorBySwarmId(swarmId) {
  const id = Number(swarmId) || 0;
  return SWARM_COLORS[Math.abs(id) % SWARM_COLORS.length];
}

/** Hypsometric ramp: near-neutral paper — faint elevation only */
const HYPSO_STOPS = [
  { t: 0.0, r: 0xe6, g: 0xe9, b: 0xec },
  { t: 0.35, r: 0xe4, g: 0xe5, b: 0xe4 },
  { t: 0.7, r: 0xdb, g: 0xd9, b: 0xd4 },
  { t: 1.0, r: 0xcd, g: 0xc9, b: 0xc2 },
];

export function elevationColor(t) {
  const clamped = Math.min(1, Math.max(0, t));
  let lo = HYPSO_STOPS[0];
  let hi = HYPSO_STOPS[HYPSO_STOPS.length - 1];

  for (let i = 0; i < HYPSO_STOPS.length - 1; i++) {
    if (clamped >= HYPSO_STOPS[i].t && clamped <= HYPSO_STOPS[i + 1].t) {
      lo = HYPSO_STOPS[i];
      hi = HYPSO_STOPS[i + 1];
    }
  }

  const span = hi.t - lo.t || 1;
  const u = (clamped - lo.t) / span;

  return {
    r: (lo.r + (hi.r - lo.r) * u) / 255,
    g: (lo.g + (hi.g - lo.g) * u) / 255,
    b: (lo.b + (hi.b - lo.b) * u) / 255,
  };
}

/** Label accent per detected object class */
export function labelColorForType(objectType) {
  switch (objectType) {
    case "person":
      return "#c4892a";
    case "user":
      return "#7c5cfc";
    case "vehicle":
      return "#5a6d7c";
    case "building":
      return "#3d4a55";
    case "flood":
      return "#0c7c93";
    case "tree":
      return "#6f8574";
    case "container":
      return "#d45a14";
    case "spawn":
      return "#0c7c93";
    default:
      return "#0c7c93";
  }
}

function hexFromThreeColor(n) {
  return `#${(n >>> 0).toString(16).padStart(6, "0")}`;
}

/** Accent for the entity inspector strip */
export function readoutAccentFor(entity) {
  if (!entity) return "#0c7c93";
  if (entity.type === "agent") {
    return hexFromThreeColor(getColorBySwarmId(entity.swarm));
  }
  if (entity.type === "target") return hexFromThreeColor(TAC.target);
  if (entity.type === "obstacle") return hexFromThreeColor(TAC.obstacle);
  if (entity.objectType) return labelColorForType(entity.objectType);
  if (entity.type === "detection" || entity.type === "map") return "#0c7c93";
  return "#0c7c93";
}

/** Human-readable kind label for the inspector eyebrow */
export function readoutKindLabel(entity) {
  if (!entity) return "ENTITY";
  if (entity.type === "agent") return "AGENT";
  if (entity.type === "target") return "TARGET";
  if (entity.type === "obstacle") return "OBSTACLE";
  if (entity.objectType) return String(entity.objectType).toUpperCase();
  if (entity.type === "detection") return "DETECTION";
  if (entity.type === "map") return "MAP";
  return String(entity.type || "ENTITY").toUpperCase();
}
