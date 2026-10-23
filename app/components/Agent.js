import * as THREE from "three";
import { createAgentMarker } from "./visuals/tacticalMarkers";

const VELOCITY_EPS = 1e-4;
const DELTA_EPS = 1e-5;
const TURN_RATE = 0.2;

function shortestAngleDelta(from, to) {
  let delta = (to - from + Math.PI) % (Math.PI * 2);
  if (delta < 0) delta += Math.PI * 2;
  return delta - Math.PI;
}

class Agent {
  constructor(id, target_id, position, z_position, velocity, acceleration, color) {
    this.id = id;
    this.target_id = target_id;
    const z = position.z !== undefined ? position.z : z_position ?? 0;
    this.position = new THREE.Vector3(position.x, position.y, z);
    this.stemLength = z_position ?? z;
    this.lastPosition = this.position.clone();
    this.velocity = new THREE.Vector3(velocity?.x ?? 0, velocity?.y ?? 0, 0);
    this.acceleration = new THREE.Vector3(acceleration?.x ?? 0, acceleration?.y ?? 0, 0);

    this.size = 0.4;
    this.detectionRadius = 0.2;
    this.batteryLife = 100;
    this.heading =
      this.velocity.lengthSq() > VELOCITY_EPS
        ? Math.atan2(this.velocity.y, this.velocity.x)
        : Math.PI / 2;

    this.mesh = createAgentMarker(color);
    this.mesh.name = `agent-${id}`;
    this.mesh.userData = {
      ...this.mesh.userData,
      entityType: "agent",
      id,
      target_id,
    };
    this.updateMeshPosition();
    this.indicators = null;
  }

  /** Heading from velocity, falling back to track delta, then last known. */
  computeTargetHeading() {
    if (this.velocity.lengthSq() > VELOCITY_EPS) {
      return Math.atan2(this.velocity.y, this.velocity.x);
    }
    const dx = this.position.x - this.lastPosition.x;
    const dy = this.position.y - this.lastPosition.y;
    if (dx * dx + dy * dy > DELTA_EPS) {
      return Math.atan2(dy, dx);
    }
    return this.heading;
  }

  updateMeshPosition() {
    this.mesh.position.copy(this.position);
    if (this.mesh.userData.setAltitudeStem) {
      this.mesh.userData.setAltitudeStem(this.stemLength ?? this.position.z);
    }

    const target = this.computeTargetHeading();
    this.heading += shortestAngleDelta(this.heading, target) * TURN_RATE;
    // marker geometry points +Y, so subtract a quarter turn
    this.mesh.rotation.z = this.heading - Math.PI / 2;

    this.lastPosition.copy(this.position);
  }

  updateColor(color) {
    if (this.mesh.userData.setColor) {
      this.mesh.userData.setColor(color);
    }
  }

  setVelocity(velocity) {
    this.velocity.set(velocity?.x ?? 0, velocity?.y ?? 0, 0);
  }

  setTargetId(target_id) {
    this.target_id = target_id;
    this.mesh.userData.target_id = target_id;
  }
}

export default Agent;
