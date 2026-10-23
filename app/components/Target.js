import * as THREE from "three";
import { createTargetMarker } from "./visuals/tacticalMarkers";
import { TAC } from "./visuals/palette";

class Target {
  constructor(id, position, radius, color = TAC.target) {
    this.id = id;
    this.position = new THREE.Vector3(position.x, position.y, position.z || 0);
    this.radius = radius;
    this.mesh = createTargetMarker(radius, color);
    this.mesh.name = `target-${id}`;
    this.mesh.userData = {
      ...this.mesh.userData,
      entityType: "target",
      id,
    };
    this.updateMeshPosition();
  }

  updateMeshPosition() {
    this.mesh.position.copy(this.position);
  }

  updateColor(color) {
    if (this.mesh.userData.setColor) {
      this.mesh.userData.setColor(color);
    }
  }
}

export default Target;
