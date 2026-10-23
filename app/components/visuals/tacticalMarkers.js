import * as THREE from "three";
import { TAC } from "./palette";
import { envToWorld, visualFootprint, visualHeightForType } from "../../data/globalVars";

const OUTLINE = 0x1e2a33;

function setGroupColor(group, color) {
  group.traverse((child) => {
    if (child.material && child.material.color && child.userData?.tintable) {
      child.material.color.set(color);
    }
  });
}

/** Flat arrowhead in the XY plane pointing +Y, so rotation.z reads as heading. */
function arrowheadShape(length = 0.13, halfWidth = 0.085, notch = 0.03) {
  const shape = new THREE.Shape();
  shape.moveTo(0, length);
  shape.lineTo(halfWidth, -length * 0.58);
  shape.lineTo(0, -notch);
  shape.lineTo(-halfWidth, -length * 0.58);
  shape.closePath();
  return shape;
}

/** UAV: heading arrowhead + center dot + altitude stem */
export function createAgentMarker(color) {
  const group = new THREE.Group();
  group.userData.kind = "agent";

  const stemGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 1),
  ]);
  const stem = new THREE.Line(
    stemGeo,
    new THREE.LineBasicMaterial({ color: TAC.agentStem, transparent: true, opacity: 0.7 })
  );
  stem.name = "altitudeStem";
  group.add(stem);

  const shape = arrowheadShape();
  const body = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
  );
  body.userData.tintable = true;
  body.name = "marker";
  body.position.z = 0.04;
  group.add(body);

  const outlinePoints = shape.getPoints(4).map((p) => new THREE.Vector3(p.x, p.y, 0.05));
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(outlinePoints),
    new THREE.LineBasicMaterial({ color: OUTLINE, transparent: true, opacity: 0.55 })
  );
  group.add(outline);

  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.018, 10),
    new THREE.MeshBasicMaterial({ color: OUTLINE, transparent: true, opacity: 0.8 })
  );
  dot.position.z = 0.06;
  group.add(dot);

  group.userData.setColor = (c) => setGroupColor(group, c);
  group.userData.setAltitudeStem = (z) => {
    const positions = stem.geometry.attributes.position;
    positions.setXYZ(0, 0, 0, -z);
    positions.setXYZ(1, 0, 0, 0);
    positions.needsUpdate = true;
  };

  return group;
}

/** Target: open diamond with center cross */
export function createTargetMarker(radius, color = TAC.target) {
  const group = new THREE.Group();
  group.userData.kind = "target";
  const size = Math.max(radius * 1.6, 0.12);

  const diamond = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, size, 0.02),
      new THREE.Vector3(size, 0, 0.02),
      new THREE.Vector3(0, -size, 0.02),
      new THREE.Vector3(-size, 0, 0.02),
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
  );
  diamond.userData.tintable = true;
  group.add(diamond);

  const cross = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-size * 0.45, 0, 0.03),
      new THREE.Vector3(size * 0.45, 0, 0.03),
      new THREE.Vector3(0, -size * 0.45, 0.03),
      new THREE.Vector3(0, size * 0.45, 0.03),
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
  );
  cross.userData.tintable = true;
  group.add(cross);

  group.userData.setColor = (c) => {
    group.traverse((child) => {
      if (child.material?.color) child.material.color.set(c);
    });
  };

  return group;
}

/** Swarm rally / spawn: ring + north tick on the deck. */
export function createSpawnMarker(radius = 0.22, color = TAC.spawn) {
  const group = new THREE.Group();
  group.name = "spawnMarker";
  group.userData.kind = "spawn";
  const r = Math.max(radius, 0.16);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.72, r, 32),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.position.z = 0.03;
  group.add(ring);

  const tick = new THREE.Mesh(
    new THREE.PlaneGeometry(r * 0.18, r * 0.42),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
  );
  tick.position.set(0, r * 0.55, 0.04);
  group.add(tick);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.16, 16),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
  );
  core.position.z = 0.04;
  group.add(core);

  return group;
}

/** Obstacle: low hatched block */
export function createObstacleMarker(radius, color = TAC.obstacle) {
  const group = new THREE.Group();
  group.userData.kind = "obstacle";
  const size = Math.max(radius * 1.4, 0.1);

  const body = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 })
  );
  body.position.z = 0.02;
  body.userData.tintable = true;
  group.add(body);

  const edges = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-size / 2, -size / 2, 0.03),
      new THREE.Vector3(size / 2, -size / 2, 0.03),
      new THREE.Vector3(size / 2, size / 2, 0.03),
      new THREE.Vector3(-size / 2, size / 2, 0.03),
    ]),
    new THREE.LineBasicMaterial({ color: OUTLINE, transparent: true, opacity: 0.6 })
  );
  group.add(edges);

  const hatchPts = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5) * size * 0.7;
    hatchPts.push(t, -size * 0.35, 0.04, t + size * 0.25, size * 0.35, 0.04);
  }
  const hatchGeo = new THREE.BufferGeometry();
  hatchGeo.setAttribute("position", new THREE.Float32BufferAttribute(hatchPts, 3));
  group.add(
    new THREE.LineSegments(
      hatchGeo,
      new THREE.LineBasicMaterial({ color: TAC.obstacle, transparent: true, opacity: 0.75 })
    )
  );

  group.userData.setColor = (c) => body.material.color.set(c);

  return group;
}

export function detectionColorForType(objectType) {
  switch (objectType) {
    case "person":
      return TAC.person;
    case "vehicle":
      return TAC.vehicle;
    case "building":
      return TAC.buildingOk;
    case "flood":
      return TAC.flood;
    case "tree":
      return TAC.tree;
    case "container":
      return TAC.container;
    default:
      return TAC.detection;
  }
}

/**
 * Extruded building volume with a roof-line for nadir readability.
 */
export function createBuildingMarker(
  scaledWidth,
  scaledHeight,
  condition = "intact",
  height = 0.8
) {
  const group = new THREE.Group();
  group.userData.kind = "building";
  group.userData.entityType = "mapObject";
  group.userData.object_type = "building";
  group.userData.createdAt = performance.now();

  const w = Math.max(scaledWidth, 1e-4);
  const h = Math.max(scaledHeight, 1e-4);
  const hz = Math.max(height, 1e-4);
  const fillColor = condition === "damaged" ? TAC.buildingDamaged : TAC.buildingOk;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, hz),
    new THREE.MeshStandardMaterial({
      color: fillColor,
      roughness: 0.85,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    })
  );
  body.position.z = hz / 2;
  body.userData.baseOpacity = 0.92;
  body.userData.tintable = true;
  group.add(body);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, hz)),
    new THREE.LineBasicMaterial({
      color: TAC.buildingStroke,
      transparent: true,
      opacity: 0.95,
    })
  );
  edges.position.z = hz / 2;
  edges.userData.baseOpacity = 0.95;
  group.add(edges);

  const iconScale = Math.min(w, h) * 0.55;
  const roofH = iconScale * 0.35;
  const bodyH = iconScale * 0.4;
  const bodyW = iconScale * 0.55;
  const z = hz + 1e-3;
  const housePts = [
    new THREE.Vector3(0, roofH + bodyH * 0.15, z),
    new THREE.Vector3(bodyW * 0.65, bodyH * 0.15, z),
    new THREE.Vector3(-bodyW * 0.65, bodyH * 0.15, z),
    new THREE.Vector3(0, roofH + bodyH * 0.15, z),
    new THREE.Vector3(-bodyW * 0.5, bodyH * 0.15, z),
    new THREE.Vector3(-bodyW * 0.5, -bodyH * 0.55, z),
    new THREE.Vector3(bodyW * 0.5, -bodyH * 0.55, z),
    new THREE.Vector3(bodyW * 0.5, bodyH * 0.15, z),
  ];
  const house = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(housePts),
    new THREE.LineBasicMaterial({
      color: TAC.buildingStroke,
      transparent: true,
      opacity: 0.95,
    })
  );
  house.userData.baseOpacity = 0.95;
  group.add(house);

  return group;
}

/** Short standing capsule for a person contact. */
export function createPersonMarker(radius = 0.01, height = 0.025, color = TAC.person) {
  const group = new THREE.Group();
  group.userData.kind = "person";
  const r = Math.max(radius, 1e-4);
  const hz = Math.max(height, 1e-4);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.05, hz, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
  );
  body.rotation.x = Math.PI / 2;
  body.position.z = hz / 2;
  body.userData.tintable = true;
  group.add(body);
  return group;
}

/** Operator avatar: person capsule + COP halo + heading tick. Forward is +Y. */
export function createUserMarker() {
  const group = new THREE.Group();
  group.name = "userMarker";
  group.userData.kind = "user";
  group.userData.entityType = "user";

  const color = TAC.user;
  const [bw, bd] = visualFootprint("person");
  const hz = visualHeightForType("person");
  const body = createPersonMarker(Math.max(bw, bd) / 2, hz, color);
  body.userData.kind = "user";
  group.add(body);

  const haloR = envToWorld(12);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(haloR * 0.72, haloR, 32),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.position.z = 0.03;
  ring.userData.kind = "user";
  group.add(ring);

  const tick = new THREE.Mesh(
    new THREE.PlaneGeometry(haloR * 0.2, haloR * 0.48),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
  );
  tick.position.set(0, haloR * 0.58, 0.04);
  tick.userData.kind = "user";
  group.add(tick);

  return group;
}

/** Trunk + canopy so a horizontal look can occlude. */
export function createTreeMarker(scaledWidth, scaledHeight, height = 0.35) {
  const group = new THREE.Group();
  group.userData.kind = "tree";
  const span = Math.max(scaledWidth, scaledHeight, 1e-4);
  const hz = Math.max(height, 1e-4);
  const trunkH = hz * 0.42;
  const canopyH = hz * 0.58;
  const trunkR = Math.max(span / 8, 0.03);
  const canopyR = Math.max(span / 2.4, 0.1);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(trunkR * 0.65, trunkR, trunkH, 6),
    new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 1 })
  );
  trunk.rotation.x = Math.PI / 2;
  trunk.position.z = trunkH / 2;
  group.add(trunk);

  const canopy = new THREE.Mesh(
    new THREE.ConeGeometry(canopyR, canopyH, 6),
    mapObjectMaterial("tree")
  );
  canopy.rotation.x = Math.PI / 2;
  canopy.position.z = trunkH + canopyH / 2;
  canopy.userData.tintable = true;
  group.add(canopy);

  return group;
}

/** Long orange ISO box — a solid wall for the X-ray demo. */
export function createContainerMarker(scaledWidth, scaledHeight, height = 0.2) {
  const group = new THREE.Group();
  group.userData.kind = "container";
  group.userData.entityType = "mapObject";
  group.userData.object_type = "container";

  const w = Math.max(scaledWidth, 1e-4);
  const d = Math.max(scaledHeight, 1e-4);
  const hz = Math.max(height, 1e-4);
  const hw = w / 2;
  const hd = d / 2;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, d, hz),
    new THREE.MeshStandardMaterial({
      color: TAC.container,
      roughness: 0.55,
      metalness: 0.15,
    })
  );
  body.position.z = hz / 2;
  body.userData.tintable = true;
  group.add(body);

  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, d, hz)),
    new THREE.LineBasicMaterial({ color: TAC.containerFrame, transparent: true, opacity: 0.95 })
  );
  frame.position.z = hz / 2;
  group.add(frame);

  const ribPts = [];
  const ribs = 10;
  const z0 = hz * 0.05;
  const z1 = hz * 0.95;
  const lip = Math.max(d * 0.01, 1e-4);
  for (let i = 0; i <= ribs; i++) {
    const x = -hw + (w * i) / ribs;
    ribPts.push(x, hd + lip, z0, x, hd + lip, z1);
    ribPts.push(x, -hd - lip, z0, x, -hd - lip, z1);
  }
  const ribGeo = new THREE.BufferGeometry();
  ribGeo.setAttribute("position", new THREE.Float32BufferAttribute(ribPts, 3));
  group.add(
    new THREE.LineSegments(
      ribGeo,
      new THREE.LineBasicMaterial({ color: TAC.containerRib, transparent: true, opacity: 0.85 })
    )
  );

  const doorZ0 = hz * 0.08;
  const doorZ1 = hz * 0.92;
  const doorLip = lip * 1.5;
  const inset = w * 0.06;
  const doorPts = [
    -w * 0.012, -hd - doorLip, doorZ0, -w * 0.012, -hd - doorLip, doorZ1,
    w * 0.012, -hd - doorLip, doorZ0, w * 0.012, -hd - doorLip, doorZ1,
    -hw + inset, -hd - doorLip, doorZ0, hw - inset, -hd - doorLip, doorZ0,
    -hw + inset, -hd - doorLip, doorZ1, hw - inset, -hd - doorLip, doorZ1,
    -hw + inset, -hd - doorLip, hz * 0.5, hw - inset, -hd - doorLip, hz * 0.5,
  ];
  const doorGeo = new THREE.BufferGeometry();
  doorGeo.setAttribute("position", new THREE.Float32BufferAttribute(doorPts, 3));
  group.add(
    new THREE.LineSegments(
      doorGeo,
      new THREE.LineBasicMaterial({ color: TAC.containerFrame, transparent: true, opacity: 0.7 })
    )
  );

  return group;
}

export function mapObjectMaterial(objectType, condition) {
  switch (objectType) {
    case "building":
      return new THREE.MeshBasicMaterial({
        color: condition === "damaged" ? TAC.buildingDamaged : TAC.buildingOk,
        transparent: true,
        opacity: 0.92,
      });
    case "flood":
      return new THREE.MeshStandardMaterial({
        color: TAC.flood,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
    case "tree":
      return new THREE.MeshStandardMaterial({ color: TAC.tree, roughness: 1 });
    case "container":
      return new THREE.MeshStandardMaterial({ color: TAC.container, roughness: 0.55, metalness: 0.15 });
    case "vehicle":
      return new THREE.MeshStandardMaterial({ color: TAC.vehicle, roughness: 0.7 });
    case "person":
      return new THREE.MeshStandardMaterial({ color: TAC.person, roughness: 0.6 });
    default:
      return new THREE.MeshStandardMaterial({ color: TAC.detection });
  }
}

/** Contact marker for live detections */
export function createDetectionMarker(
  scaledWidth,
  scaledHeight,
  objectType,
  condition,
  height,
  { halo } = {}
) {
  const hz = Math.max(height ?? 1e-4, 1e-4);
  if (objectType === "building") {
    const group = createBuildingMarker(scaledWidth, scaledHeight, condition, hz);
    group.userData.kind = "detection";
    group.userData.entityType = "detection";

    const maxDim = Math.max(scaledWidth, scaledHeight, halo ?? 0, 1e-4);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(maxDim * 0.62, maxDim * 0.7, 24),
      new THREE.MeshBasicMaterial({
        color: condition === "damaged" ? TAC.buildingDamaged : TAC.buildingOk,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.name = "pulseRing";
    ring.position.z = hz + 0.04;
    group.add(ring);
    return group;
  }

  if (objectType === "person") {
    const color = detectionColorForType(objectType);
    const group = createPersonMarker(Math.max(scaledWidth, scaledHeight) / 2, hz, color);
    group.userData.kind = "detection";
    group.userData.entityType = "detection";
    group.userData.createdAt = performance.now();
    const ringR = Math.max(halo ?? 0, scaledWidth, scaledHeight, 1e-4);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(ringR * 0.7, ringR * 0.85, 24),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.name = "pulseRing";
    ring.position.z = 0.04;
    group.add(ring);
    return group;
  }

  if (objectType === "tree") {
    const group = createTreeMarker(scaledWidth, scaledHeight, hz);
    group.userData.kind = "detection";
    group.userData.entityType = "detection";
    group.userData.createdAt = performance.now();
    return group;
  }

  if (objectType === "container") {
    const group = createContainerMarker(scaledWidth, scaledHeight, hz);
    group.userData.kind = "detection";
    group.userData.entityType = "detection";
    group.userData.createdAt = performance.now();
    return group;
  }

  const group = new THREE.Group();
  group.userData.kind = "detection";
  group.userData.createdAt = performance.now();

  const color = detectionColorForType(objectType);
  const w = Math.max(scaledWidth, 1e-4);
  const h = Math.max(scaledHeight, 1e-4);

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
  );
  fill.position.z = 0.05;
  fill.userData.baseOpacity = 0.22;
  group.add(fill);

  const edges = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-w / 2, -h / 2, 0.06),
      new THREE.Vector3(w / 2, -h / 2, 0.06),
      new THREE.Vector3(w / 2, h / 2, 0.06),
      new THREE.Vector3(-w / 2, h / 2, 0.06),
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
  );
  edges.userData.baseOpacity = 0.95;
  group.add(edges);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(w, h) * 0.55, Math.max(w, h) * 0.62, 24),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.name = "pulseRing";
  ring.position.z = 0.07;
  group.add(ring);

  return group;
}

export function updateDetectionPulse(group, now = performance.now()) {
  const ring = group.getObjectByName("pulseRing");
  if (!ring) return;
  const age = (now - (group.userData.createdAt || now)) / 1000;
  const pulse = 0.35 + 0.45 * Math.abs(Math.sin(age * 3));
  ring.material.opacity = Math.max(0, 0.7 - age * 0.12);
  ring.scale.setScalar(1 + pulse * 0.15);

  group.traverse((child) => {
    if (child.name === "pulseRing") return;
    const base = child.userData?.baseOpacity;
    if (base && child.material?.transparent) {
      child.material.opacity = Math.max(base * 0.55, base * (1 - Math.min(age, 10) * 0.03));
    }
  });
}
