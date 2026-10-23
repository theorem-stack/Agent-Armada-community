import * as THREE from "three";
import { contourColor, contourColorHex } from "./palette";
import { THREE_WIDTH, THREE_HEIGHT } from "../../data/globalVars";
import { normalize, TERRAIN_BASE, TERRAIN_RELIEF, TERRAIN_LABEL_METERS_PER_UNIT } from "./heightField";

/** Heightmap units → display elevation (meters). */
const ELEV_SCALE = TERRAIN_LABEL_METERS_PER_UNIT;

function interp(v1, v2, p1, p2, level) {
  const denom = v2 - v1;
  if (Math.abs(denom) < 1e-9) return p1;
  return p1 + ((level - v1) / denom) * (p2 - p1);
}

/**
 * Marching squares over the shared height field.
 * Returns flat [x1,y1,x2,y2, ...] segment pairs in world space.
 */
function segmentsForLevel(field, level, width, height) {
  const { values, size } = field;
  const segs = [];
  const xAt = (c) => -width / 2 + (c / (size - 1)) * width;
  const yAt = (r) => height / 2 - (r / (size - 1)) * height;

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const tl = values[r][c];
      const tr = values[r][c + 1];
      const br = values[r + 1][c + 1];
      const bl = values[r + 1][c];

      const idx =
        (tl > level ? 8 : 0) |
        (tr > level ? 4 : 0) |
        (br > level ? 2 : 0) |
        (bl > level ? 1 : 0);

      if (idx === 0 || idx === 15) continue;

      const x0 = xAt(c);
      const x1 = xAt(c + 1);
      const y0 = yAt(r);
      const y1 = yAt(r + 1);

      const T = [interp(tl, tr, x0, x1, level), y0];
      const R = [x1, interp(tr, br, y0, y1, level)];
      const B = [interp(bl, br, x0, x1, level), y1];
      const L = [x0, interp(tl, bl, y0, y1, level)];

      const push = (a, b) => segs.push(a[0], a[1], b[0], b[1]);

      switch (idx) {
        case 1:
        case 14:
          push(L, B);
          break;
        case 2:
        case 13:
          push(B, R);
          break;
        case 3:
        case 12:
          push(L, R);
          break;
        case 4:
        case 11:
          push(T, R);
          break;
        case 6:
        case 9:
          push(T, B);
          break;
        case 7:
        case 8:
          push(T, L);
          break;
        case 5:
          push(T, L);
          push(B, R);
          break;
        case 10:
          push(T, R);
          push(L, B);
          break;
        default:
          break;
      }
    }
  }

  return segs;
}

/** Cartographic "nice" step for readable elevation intervals. */
function niceInterval(range, targetCount) {
  if (!(range > 0)) return 1;
  const rough = range / Math.max(3, targetCount);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / mag;
  let nice = 10;
  if (residual < 1.5) nice = 1;
  else if (residual < 3) nice = 2;
  else if (residual < 7) nice = 5;
  return nice * mag;
}

/** Pick label anchors near the AOI centre along a contour. */
function labelAnchors(segs, count = 2) {
  if (segs.length < 4) return [];
  const scored = [];
  for (let s = 0; s < segs.length; s += 4) {
    const x = (segs[s] + segs[s + 2]) / 2;
    const y = (segs[s + 1] + segs[s + 3]) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    scored.push({ x, y, d: x * x + y * y });
  }
  scored.sort((a, b) => a.d - b.d);
  const out = [];
  const minSep2 = 1.2 * 1.2;
  for (const p of scored) {
    if (out.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < minSep2)) continue;
    out.push(p);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Contour overlay: elevation-tinted minors + heavier index lines,
 * with colour-matched DOM elevation labels.
 */
export function createContours(
  field,
  {
    width = THREE_WIDTH,
    height = THREE_HEIGHT,
    targetLevels = 8,
    elevScale = ELEV_SCALE,
  } = {}
) {
  const group = new THREE.Group();
  group.name = "contours";

  const labels = [];
  const minorLines = [];
  const indexLines = [];
  const elevMin = field.min * elevScale;
  const elevMax = field.max * elevScale;
  const elevRange = elevMax - elevMin || 1;
  const interval = niceInterval(elevRange, targetLevels);
  const indexEvery = 2;

  const first = Math.ceil((elevMin + interval * 0.05) / interval) * interval;
  const last = Math.floor((elevMax - interval * 0.05) / interval) * interval;

  let levelIndex = 0;
  for (let elev = first; elev <= last + interval * 0.001; elev += interval) {
    levelIndex += 1;
    const t = (elev - elevMin) / elevRange;
    const heightLevel = elev / elevScale;
    const isIndex = levelIndex % indexEvery === 0;
    const segs = segmentsForLevel(field, heightLevel, width, height);
    if (!segs.length) continue;
    const z = (field.base ?? TERRAIN_BASE) + normalize(field, heightLevel) * (field.relief ?? TERRAIN_RELIEF) + 0.002;

    const tint = contourColor(t);
    const positions = [];
    const colors = [];
    for (let s = 0; s < segs.length; s += 4) {
      positions.push(segs[s], segs[s + 1], z, segs[s + 2], segs[s + 3], z);
      colors.push(tint.r, tint.g, tint.b, tint.r, tint.g, tint.b);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

    const line = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: isIndex ? 0.92 : 0.55,
        depthWrite: false,
      })
    );
    line.name = isIndex ? `contourIndex-${elev}` : `contourMinor-${elev}`;
    line.renderOrder = isIndex ? 3 : 2;
    (isIndex ? indexLines : minorLines).push(line);

    if (isIndex) {
      const hex = contourColorHex(t);
      const anchors = labelAnchors(segs, 2);
      anchors.forEach((a, ai) => {
        labels.push({
          id: `contour-${elev}-${ai}`,
          type: "contour",
          title: `${Math.round(elev)} m`,
          color: hex,
          position: new THREE.Vector3(a.x, a.y, z),
        });
      });
    }
  }

  minorLines.forEach((line) => group.add(line));
  indexLines.forEach((line) => group.add(line));

  return { group, labels };
}
