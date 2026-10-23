import { THREE_HEIGHT, THREE_WIDTH, WORLD_SCALE } from "../../data/globalVars";

/**
 * Shared upsampled height field so terrain shading, contours, and object
 * seating use identical relief.
 *
 * Heightmap cells are env meters. Mesh Z is vertically exaggerated so hills
 * read on the COP; the floor stays at z=0 so the AOI is not a pit. Peaks stay
 * below cruise altitude. Objects keep true WORLD_SCALE heights on that surface.
 */
/** Heightmap cell → env meters. */
export const TERRAIN_METERS_PER_UNIT = 1;
/**
 * Cartographic vertical exaggeration vs true meters.
 * 5× → 8 m source becomes 40 m visual (0.5 world). Buildings 22 m, drones 50 m.
 */
export const TERRAIN_EXAGGERATION = 5;
/** Contour labels match the exaggerated surface. */
export const TERRAIN_LABEL_METERS_PER_UNIT = TERRAIN_METERS_PER_UNIT * TERRAIN_EXAGGERATION;
const HEIGHTMAP_MAX = 8;
export const TERRAIN_RELIEF =
  HEIGHTMAP_MAX * TERRAIN_METERS_PER_UNIT * WORLD_SCALE * TERRAIN_EXAGGERATION;
export const TERRAIN_BASE = 0;

function bilinearSample(heightMap, u, v) {
  const rows = heightMap.length;
  const cols = heightMap[0].length;
  const x = u * (cols - 1);
  const y = v * (rows - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, cols - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const fx = x - x0;
  const fy = y - y0;

  const h00 = heightMap[y0][x0];
  const h10 = heightMap[y0][x1];
  const h01 = heightMap[y1][x0];
  const h11 = heightMap[y1][x1];

  return (
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  );
}

/** Cosine easing keeps the coarse 5x5 source from looking faceted. */
function smoothStep(t) {
  return t * t * (3 - 2 * t);
}

export function buildHeightField(heightMap, size = 96) {
  const values = new Array(size);
  let min = Infinity;
  let max = -Infinity;

  for (let r = 0; r < size; r++) {
    values[r] = new Array(size);
    for (let c = 0; c < size; c++) {
      const u = smoothStep(c / (size - 1));
      const v = smoothStep(r / (size - 1));
      const h = bilinearSample(heightMap, u, v);
      values[r][c] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  const vis = TERRAIN_METERS_PER_UNIT * WORLD_SCALE * TERRAIN_EXAGGERATION;
  return {
    values,
    min,
    max,
    size,
    base: TERRAIN_BASE,
    relief: (max - min) * vis,
  };
}

/** Sample the built field in normalized [0,1] space. */
export function sampleField(field, u, v) {
  return bilinearSample(field.values, u, v);
}

export function normalize(field, value) {
  const range = field.max - field.min || 1;
  return (value - field.min) / range;
}

/** Map-local Z of the terrain surface at a Three.js XY. */
export function surfaceZAtThree(
  field,
  x,
  y,
  {
    width = THREE_WIDTH,
    height = THREE_HEIGHT,
    relief,
    base,
    zScale = 1,
  } = {}
) {
  if (!field) return 0;
  const u = Math.min(1, Math.max(0, (x + width / 2) / width));
  const v = Math.min(1, Math.max(0, (y + height / 2) / height));
  const h = sampleField(field, u, 1 - v);
  const t = normalize(field, h);
  const z0 = base ?? field.base ?? TERRAIN_BASE;
  const zr = relief ?? field.relief ?? TERRAIN_RELIEF;
  return (z0 + t * zr) * zScale;
}
