import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { TAC } from "./palette";
import {
  ENV_WIDTH,
  ENV_HEIGHT,
  THREE_WIDTH,
  THREE_HEIGHT,
} from "../../data/globalVars";
import { TERRAIN_BASE, TERRAIN_RELIEF } from "./heightField";

/** Env meters per Three.js world unit (uniform scale). */
export function metersPerWorldUnit(
  envWidth = ENV_WIDTH,
  envHeight = ENV_HEIGHT,
  threeWidth = THREE_WIDTH,
  threeHeight = THREE_HEIGHT
) {
  const aspectEnv = envWidth / envHeight;
  const aspectThree = threeWidth / threeHeight;
  if (aspectEnv > aspectThree) return envWidth / threeWidth;
  return envHeight / threeHeight;
}

// Flat plane just above the highest hill so terrain never clips the reticle;
// extruded markers still occlude it as background context.
const RANGE_Z = TERRAIN_BASE + TERRAIN_RELIEF + 0.06;
const RING_COUNT = 3;
const CIRCLE_SEGMENTS = 160;
const RING_MANTISSAS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
/** Reticle stroke opacities for the HUD intensity toggle. */
export const RETICLE_OPACITY = { normal: 0.32, faint: 0.1 };
// Arc labels sit in the NE quadrant so they stay clear of the compass cluster.
const RING_LABEL_BEARING = Math.PI / 4;

/** Largest "nice" value (mantissa x 10^n) that does not exceed the input. */
function niceFloor(value, mantissas) {
  if (!(value > 0)) return 1;
  const decade = Math.pow(10, Math.floor(Math.log10(value)));
  const mantissa = value / decade;
  let chosen = mantissas[0];
  for (const candidate of mantissas) {
    if (candidate <= mantissa + 1e-9) chosen = candidate;
  }
  return chosen * decade;
}

function formatMeters(meters) {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  const rounded = Math.round(meters * 10) / 10;
  return `${rounded} m`;
}

function unitCirclePositions() {
  const positions = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a0 = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
    positions.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
  }
  return positions;
}

/**
 * View-anchored range reticle.
 *
 * Lives in world space (not under mapRoot) so the hub stays at the centre of
 * whatever the operator is looking at while panning and rotating. Ring radii
 * re-derive from the visible extent on every camera change.
 */
export function createDistanceFrame({
  envWidth = ENV_WIDTH,
  envHeight = ENV_HEIGHT,
  width = THREE_WIDTH,
  height = THREE_HEIGHT,
} = {}) {
  const mpu = metersPerWorldUnit(envWidth, envHeight, width, height);

  const group = new THREE.Group();
  group.name = "distanceFrame";

  const materials = [];
  const geometries = [];

  const makeMaterial = (color, opacity, linewidth) => {
    const material = new LineMaterial({
      color: new THREE.Color(color),
      linewidth,
      opacity,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    materials.push(material);
    return material;
  };

  const makeStroke = ({ color, opacity, linewidth, order = 0, positions, capacity = 0 }) => {
    const geometry = new LineSegmentsGeometry();
    const buffer = positions
      ? new Float32Array(positions)
      : new Float32Array(capacity * 6);
    geometry.setPositions(buffer);
    if (!positions) geometry.instanceCount = 0;
    geometries.push(geometry);

    const node = new THREE.Group();
    const line = new LineSegments2(geometry, makeMaterial(color, opacity, linewidth));
    line.frustumCulled = false;
    line.raycast = () => {};
    line.renderOrder = 10 + order;
    node.add(line);

    node.userData.geometry = geometry;
    node.userData.buffer = buffer;
    return node;
  };

  const writeSegments = (node, values) => {
    const { geometry, buffer } = node.userData;
    const count = Math.min(values.length, buffer.length);
    for (let i = 0; i < count; i++) buffer[i] = values[i];
    geometry.attributes.instanceStart.data.needsUpdate = true;
    geometry.instanceCount = Math.floor(count / 6);
  };

  const ringsNode = new THREE.Group();
  ringsNode.name = "rangeRings";
  group.add(ringsNode);

  const circle = unitCirclePositions();
  const rings = [
    { linewidth: 1.6 },
    { linewidth: 1.8 },
    { linewidth: 2.2 },
  ]
    .slice(0, RING_COUNT)
    .map((style, index) =>
      makeStroke({
        color: TAC.range,
        opacity: RETICLE_OPACITY.normal,
        linewidth: style.linewidth,
        order: index,
        positions: circle,
      })
    );
  rings.forEach((ring) => ringsNode.add(ring));

  const hub = makeStroke({
    color: TAC.range,
    opacity: RETICLE_OPACITY.normal,
    linewidth: 1.8,
    order: 5,
    capacity: 40,
  });
  ringsNode.add(hub);

  const resolution = new THREE.Vector2(0, 0);
  let signature = "";
  let labels = [];
  let currentOpacity = RETICLE_OPACITY.normal;

  const setOpacity = (opacity) => {
    const next = Number.isFinite(opacity) ? opacity : RETICLE_OPACITY.normal;
    if (Math.abs(next - currentOpacity) < 1e-6) return;
    currentOpacity = next;
    materials.forEach((material) => {
      material.opacity = next;
    });
  };

  const setVisible = (visible) => {
    group.visible = Boolean(visible);
  };

  const update = ({ camera, yaw = 0, viewWidth = 0, viewHeight = 0 } = {}) => {
    if (!camera || viewWidth <= 0 || viewHeight <= 0) return labels;

    const halfW = (camera.right - camera.left) / 2;
    const halfH = (camera.top - camera.bottom) / 2;
    const cx = camera.position.x;
    const cy = camera.position.y;

    const next = `${cx.toFixed(4)}|${cy.toFixed(4)}|${halfW.toFixed(4)}|${halfH.toFixed(
      4
    )}|${yaw.toFixed(4)}|${viewWidth}|${viewHeight}`;
    if (next === signature) return labels;
    signature = next;

    if (resolution.x !== viewWidth || resolution.y !== viewHeight) {
      resolution.set(viewWidth, viewHeight);
      materials.forEach((material) => material.resolution.set(viewWidth, viewHeight));
    }

    const worldPerPx = (halfH * 2) / viewHeight;
    const px = (n) => n * worldPerPx;
    const bearingX = Math.cos(RING_LABEL_BEARING);
    const bearingY = Math.sin(RING_LABEL_BEARING);
    const screenCx = viewWidth / 2;
    const screenCy = viewHeight / 2;

    ringsNode.position.set(cx, cy, RANGE_Z);

    const ringStepM = Math.max(
      1,
      niceFloor((Math.min(halfW, halfH) * 0.88 * mpu) / RING_COUNT, RING_MANTISSAS)
    );

    const nextLabels = [];

    rings.forEach((ring, index) => {
      const meters = ringStepM * (index + 1);
      const radius = meters / mpu;
      ring.scale.setScalar(radius);

      const rPx = radius / worldPerPx;
      // Declutter anchor at the NE point on the ring
      const x = screenCx + bearingX * rPx;
      const y = screenCy - bearingY * rPx;

      nextLabels.push({
        id: `range-${index}`,
        type: "range",
        title: formatMeters(meters),
        cx: screenCx,
        cy: screenCy,
        r: rPx,
        x,
        y,
      });
    });

    // --- Centre hub: gapped crosshair plus a live north tick -------------
    const arm = px(12);
    const gap = px(4.5);
    const hubRadius = px(4.5);
    const hubPositions = [
      -arm, 0, 0, -gap, 0, 0,
      gap, 0, 0, arm, 0, 0,
      0, -arm, 0, 0, -gap, 0,
      0, gap, 0, 0, arm, 0,
    ];
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * Math.PI * 2;
      const a1 = ((i + 1) / 24) * Math.PI * 2;
      hubPositions.push(
        Math.cos(a0) * hubRadius,
        Math.sin(a0) * hubRadius,
        0,
        Math.cos(a1) * hubRadius,
        Math.sin(a1) * hubRadius,
        0
      );
    }
    const northX = -Math.sin(yaw);
    const northY = Math.cos(yaw);
    hubPositions.push(
      northX * px(8),
      northY * px(8),
      0,
      northX * px(15),
      northY * px(15),
      0
    );
    writeSegments(hub, hubPositions);

    labels = nextLabels;
    return labels;
  };

  const dispose = () => {
    materials.forEach((material) => material.dispose());
    geometries.forEach((geometry) => geometry.dispose());
  };

  return { group, update, setOpacity, setVisible, dispose, metersPerUnit: mpu };
}
