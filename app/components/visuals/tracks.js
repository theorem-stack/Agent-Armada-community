import * as THREE from "three";
import { TAC } from "./palette";

const TRAIL_LENGTH = 28;

/**
 * Per-agent fading trail + velocity vector + assignment link managers.
 */
export function createTrackLayer() {
  const group = new THREE.Group();
  group.name = "trackLayer";

  const trails = new Map(); // agentId -> { line, positions: Vector3[] }
  const velocities = new Map(); // agentId -> ArrowHelper
  const links = new Map(); // agentId -> Line

  function ensureTrail(agentId) {
    if (trails.has(agentId)) return trails.get(agentId);
    const positions = [];
    const geo = new THREE.BufferGeometry();
    const maxVerts = TRAIL_LENGTH;
    const arr = new Float32Array(maxVerts * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: TAC.trail,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    line.frustumCulled = false;
    group.add(line);
    const entry = { line, positions };
    trails.set(agentId, entry);
    return entry;
  }

  function pushTrail(agentId, position) {
    const entry = ensureTrail(agentId);
    entry.positions.push(position.clone());
    if (entry.positions.length > TRAIL_LENGTH) {
      entry.positions.shift();
    }
    const attr = entry.line.geometry.attributes.position;
    for (let i = 0; i < entry.positions.length; i++) {
      const p = entry.positions[i];
      attr.setXYZ(i, p.x, p.y, p.z + 0.03);
    }
    attr.needsUpdate = true;
    entry.line.geometry.setDrawRange(0, entry.positions.length);
    entry.line.material.opacity = 0.35 + 0.35 * (entry.positions.length / TRAIL_LENGTH);
  }

  function updateVelocity(agentId, origin, velocity) {
    const vx = velocity?.x ?? 0;
    const vy = velocity?.y ?? 0;
    const speed = Math.hypot(vx, vy);
    if (speed < 1e-4) {
      const existing = velocities.get(agentId);
      if (existing) existing.visible = false;
      return;
    }

    const dir = new THREE.Vector3(vx, vy, 0).normalize();
    const len = Math.min(0.55, 0.12 + speed * 0.02);

    let arrow = velocities.get(agentId);
    if (!arrow) {
      arrow = new THREE.ArrowHelper(dir, origin, len, TAC.velocity, 0.08, 0.05);
      arrow.line.material.transparent = true;
      arrow.line.material.opacity = 0.75;
      arrow.cone.material.transparent = true;
      arrow.cone.material.opacity = 0.75;
      group.add(arrow);
      velocities.set(agentId, arrow);
    } else {
      arrow.visible = true;
      arrow.position.copy(origin);
      arrow.setDirection(dir);
      arrow.setLength(len, 0.08, 0.05);
    }
  }

  function updateLink(agentId, fromPos, toPos) {
    if (!toPos) {
      const existing = links.get(agentId);
      if (existing) existing.visible = false;
      return;
    }

    let line = links.get(agentId);
    if (!line) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        fromPos.clone(),
        toPos.clone(),
      ]);
      line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: TAC.link,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        })
      );
      line.frustumCulled = false;
      group.add(line);
      links.set(agentId, line);
    } else {
      line.visible = true;
      const attr = line.geometry.attributes.position;
      attr.setXYZ(0, fromPos.x, fromPos.y, fromPos.z + 0.02);
      attr.setXYZ(1, toPos.x, toPos.y, toPos.z + 0.02);
      attr.needsUpdate = true;
    }
  }

  function prune(activeAgentIds) {
    const active = new Set(activeAgentIds.map(String));
    for (const [id, entry] of trails) {
      if (!active.has(String(id))) {
        group.remove(entry.line);
        entry.line.geometry.dispose();
        entry.line.material.dispose();
        trails.delete(id);
      }
    }
    for (const [id, arrow] of velocities) {
      if (!active.has(String(id))) {
        group.remove(arrow);
        velocities.delete(id);
      }
    }
    for (const [id, line] of links) {
      if (!active.has(String(id))) {
        group.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        links.delete(id);
      }
    }
  }

  return {
    group,
    pushTrail,
    updateVelocity,
    updateLink,
    prune,
  };
}
