import * as THREE from "three";
import { TAC } from "./palette";
import {
  ALTITUDE_SCALE,
  SENSOR_HALF_ANGLE,
  SENSOR_RANGE,
} from "../../data/globalVars";

const MAX_RANGE = SENSOR_RANGE * ALTITUDE_SCALE;
const TAN_HALF = Math.tan((SENSOR_HALF_ANGLE * Math.PI) / 180);
const GROUND_EPS = 0.012;

function makeConeMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function makeGhostMaterial() {
  return new THREE.MeshBasicMaterial({
    color: TAC.xray,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    wireframe: true,
  });
}

/**
 * Drone sensor cones + operator X-ray ghosts for fused tracks.
 */
export function createFusionLayer() {
  const group = new THREE.Group();
  group.name = "fusionLayer";
  group.userData.kind = "fusion";

  const coneRoot = new THREE.Group();
  coneRoot.name = "sensorCones";
  group.add(coneRoot);

  const rayRoot = new THREE.Group();
  rayRoot.name = "observerRays";
  group.add(rayRoot);

  const ghostRoot = new THREE.Group();
  ghostRoot.name = "xrayGhosts";
  group.add(ghostRoot);

  const cones = new Map();
  const rays = new Map();
  const ghosts = new Map();

  function setPresentation({ cones = false, rays = false, ghosts = false } = {}) {
    coneRoot.visible = Boolean(cones);
    rayRoot.visible = Boolean(rays);
    ghostRoot.visible = Boolean(ghosts);
  }

  function setInspecting(on) {
    setPresentation({ cones: on, rays: on, ghosts: on });
  }

  function upsertCone(id, position, color, groundZ = 0) {
    const alt = Math.max(position.z - groundZ, 1e-4);
    const h = Math.min(alt, MAX_RANGE);
    const radius = h * TAN_HALF;
    const baseZ = position.z - h;
    let entry = cones.get(id);
    if (!entry) {
      const mesh = new THREE.Mesh(
        new THREE.ConeGeometry(TAN_HALF, 1, 28, 1, true),
        makeConeMaterial(color ?? TAC.cone)
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.raycast = () => {};
      mesh.userData.kind = "fusion";
      coneRoot.add(mesh);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 32),
        new THREE.MeshBasicMaterial({
          color: color ?? TAC.cone,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      ring.raycast = () => {};
      ring.userData.kind = "fusion";
      coneRoot.add(ring);
      entry = { mesh, ring };
      cones.set(id, entry);
    } else if (color != null) {
      entry.mesh.material.color.set(color);
      entry.ring.material.color.set(color);
    }
    entry.mesh.scale.set(h, h, h);
    entry.mesh.position.set(position.x, position.y, position.z - h / 2);
    entry.ring.scale.set(radius, radius, 1);
    entry.ring.position.set(position.x, position.y, baseZ + GROUND_EPS);
    entry.mesh.visible = true;
    entry.ring.visible = true;
  }

  function pruneCones(activeIds) {
    const keep = new Set(activeIds.map(String));
    for (const [id, entry] of cones) {
      if (keep.has(String(id))) continue;
      coneRoot.remove(entry.mesh, entry.ring);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.ring.geometry.dispose();
      entry.ring.material.dispose();
      cones.delete(id);
    }
  }

  function clearRays() {
    for (const line of rays.values()) {
      rayRoot.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    rays.clear();
  }

  function setRays(segments) {
    clearRays();
    segments.forEach((seg, index) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(seg.from.x, seg.from.y, seg.from.z),
        new THREE.Vector3(seg.to.x, seg.to.y, seg.to.z),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: TAC.xray,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        })
      );
      line.raycast = () => {};
      line.userData.kind = "fusion";
      rayRoot.add(line);
      rays.set(String(index), line);
    });
  }

  function ghostGeometry(objectType, width, depth, height) {
    const hz = Math.max(height, 1e-4);
    const w = Math.max(width, 1e-4);
    const d = Math.max(depth, 1e-4);
    if (objectType === "person") {
      const radius = Math.max(w, d) / 2;
      return {
        geometry: new THREE.CylinderGeometry(radius, radius * 1.05, hz, 10),
        rotateX: Math.PI / 2,
      };
    }
    if (objectType === "tree") {
      return {
        geometry: new THREE.ConeGeometry(Math.max(w, d) / 2, hz, 6),
        rotateX: Math.PI / 2,
      };
    }
    return {
      geometry: new THREE.BoxGeometry(w, d, hz),
      rotateX: 0,
    };
  }

  function upsertGhost(id, position, opts = {}) {
    const objectType = String(opts.objectType || "person").toLowerCase();
    const height = opts.height ?? 0.025;
    const width = opts.width ?? (opts.radius != null ? opts.radius * 2 : 0.01);
    const depth = opts.depth ?? (opts.radius != null ? opts.radius * 2 : 0.01);
    const shapeKey = `${objectType}:${width.toFixed(3)}:${depth.toFixed(3)}:${height.toFixed(3)}`;
    let ghost = ghosts.get(id);
    if (!ghost) {
      const shaped = ghostGeometry(objectType, width, depth, height);
      ghost = new THREE.Mesh(shaped.geometry, makeGhostMaterial());
      ghost.rotation.x = shaped.rotateX;
      ghost.scale.setScalar(1.08);
      ghost.renderOrder = 999;
      ghost.raycast = () => {};
      ghost.userData.kind = "fusion";
      ghost.userData.shapeKey = shapeKey;
      ghostRoot.renderOrder = 999;
      ghostRoot.add(ghost);
      ghosts.set(id, ghost);
    } else if (ghost.userData.shapeKey !== shapeKey) {
      ghost.geometry.dispose();
      const shaped = ghostGeometry(objectType, width, depth, height);
      ghost.geometry = shaped.geometry;
      ghost.rotation.x = shaped.rotateX;
      ghost.userData.shapeKey = shapeKey;
    }
    ghost.position.set(position.x, position.y, position.z + height / 2);
    ghost.visible = true;
    return ghost;
  }

  function hideGhosts() {
    ghosts.forEach((ghost) => {
      ghost.visible = false;
    });
  }

  function pruneGhosts(activeIds) {
    const keep = new Set(activeIds.map(String));
    for (const [id, ghost] of ghosts) {
      if (keep.has(String(id))) continue;
      ghostRoot.remove(ghost);
      ghost.geometry.dispose();
      ghost.material.dispose();
      ghosts.delete(id);
    }
  }

  function dispose() {
    pruneCones([]);
    clearRays();
    pruneGhosts([]);
  }

  return {
    group,
    setPresentation,
    setInspecting,
    upsertCone,
    pruneCones,
    setRays,
    upsertGhost,
    hideGhosts,
    pruneGhosts,
    dispose,
  };
}
