import * as THREE from "three";
import { ENV_HEIGHT, ENV_WIDTH, THREE_HEIGHT, THREE_WIDTH } from "../../data/globalVars";
import { TAC } from "./palette";

/** Matches agent radius indicator (`Agent.detectionRadius`). */
export const SELECTION_RADIUS = 0.2;

export function gizmoRadiusFor(root) {
  const fp = root?.userData?.footprint;
  if (Array.isArray(fp) && fp.length >= 2) {
    const w = (Number(fp[0]) * THREE_WIDTH) / ENV_WIDTH;
    const h = (Number(fp[1]) * THREE_HEIGHT) / ENV_HEIGHT;
    return Math.max(Math.hypot(w, h) * 0.5 + 0.16, 0.22);
  }
  return SELECTION_RADIUS;
}

/**
 * World-space selection / edit gizmo. The ring stays axis-aligned; only the
 * heading arm tracks the host so rotate and move do not inherit object spin.
 */
export function createSelectionHighlight() {
  const group = new THREE.Group();
  group.name = "selectionHighlight";
  group.userData.kind = "editGizmo";
  group.renderOrder = 18;
  group.visible = false;

  const discMat = new THREE.MeshBasicMaterial({
    color: TAC.radius,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(SELECTION_RADIUS, 48), discMat);
  disc.position.z = 0.05;
  disc.frustumCulled = false;
  disc.raycast = () => {};
  group.add(disc);

  const ringMat = new THREE.MeshBasicMaterial({
    color: TAC.aoi,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.22, 64), ringMat);
  ring.userData.kind = "rotateHandle";
  ring.position.z = 0.07;
  ring.visible = false;
  ring.frustumCulled = false;
  ring.raycast = () => {};
  group.add(ring);

  const ringHitMat = new THREE.MeshBasicMaterial({
    color: TAC.aoi,
    transparent: true,
    opacity: 0.04,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const ringHit = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.32, 64), ringHitMat);
  ringHit.userData.kind = "rotateHandle";
  ringHit.position.z = 0.065;
  ringHit.visible = false;
  ringHit.frustumCulled = false;
  group.add(ringHit);

  const handleMat = new THREE.MeshBasicMaterial({
    color: TAC.aoi,
    depthWrite: false,
    depthTest: false,
  });
  const handle = new THREE.Group();
  handle.name = "rotateHandle";
  handle.userData.kind = "rotateHandle";
  handle.visible = false;

  const stem = new THREE.Mesh(new THREE.BoxGeometry(1, 0.03, 0.03), handleMat);
  stem.userData.kind = "rotateHandle";
  handle.add(stem);

  const knob = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24), handleMat);
  knob.userData.kind = "rotateHandle";
  knob.position.z = 0.08;
  handle.add(knob);
  group.add(handle);

  let host = null;
  let reach = SELECTION_RADIUS + 0.2;

  function layout(radius) {
    const r = Math.max(radius || SELECTION_RADIUS, 0.16);
    reach = r + 0.22;
    disc.geometry.dispose();
    disc.geometry = new THREE.CircleGeometry(r, 48);
    ring.geometry.dispose();
    ring.geometry = new THREE.RingGeometry(Math.max(r - 0.02, 0.08), r + 0.02, 64);
    ringHit.geometry.dispose();
    ringHit.geometry = new THREE.RingGeometry(Math.max(r - 0.08, 0.06), r + 0.12, 64);
    stem.geometry.dispose();
    stem.geometry = new THREE.BoxGeometry(0.22, 0.03, 0.03);
    stem.position.set(r + 0.11, 0, 0.07);
    knob.position.set(reach, 0, 0.08);
  }

  function setRadius(radius) {
    layout(radius);
  }

  function setEdit(on) {
    const edit = Boolean(on);
    disc.visible = !edit;
    ring.visible = edit;
    ringHit.visible = edit;
    handle.visible = edit;
  }

  function follow() {
    if (!host) return;
    group.position.set(host.position.x, host.position.y, (host.position.z || 0) + 0.06);
    handle.rotation.z = host.rotation.z || 0;
  }

  function attach(root, { radius = SELECTION_RADIUS, edit = false } = {}) {
    host = root || null;
    if (!host) {
      clear();
      return;
    }
    setRadius(radius);
    setEdit(edit);
    follow();
    group.visible = true;
  }

  function clear() {
    host = null;
    group.visible = false;
    setEdit(false);
  }

  function dispose() {
    clear();
    if (group.parent) group.parent.remove(group);
    disc.geometry.dispose();
    ring.geometry.dispose();
    ringHit.geometry.dispose();
    stem.geometry.dispose();
    knob.geometry.dispose();
    discMat.dispose();
    ringMat.dispose();
    ringHitMat.dispose();
    handleMat.dispose();
  }

  return {
    group,
    attach,
    clear,
    dispose,
    setEdit,
    follow,
    host: () => host,
  };
}
