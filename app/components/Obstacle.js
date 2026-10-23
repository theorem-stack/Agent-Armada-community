import * as THREE from "three";
import { createObstacleMarker } from "./visuals/tacticalMarkers";
import { TAC } from "./visuals/palette";

class Obstacle {
  constructor(id, position, radius, color = TAC.obstacle) {
    this.id = id;
    this.position = new THREE.Vector3(position.x, position.y, position.z || 0);
    this.radius = radius;
    this.mesh = createObstacleMarker(radius, color);
    this.mesh.name = `obstacle-${id}`;
    this.mesh.userData = {
      ...this.mesh.userData,
      entityType: "obstacle",
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

export default Obstacle;
