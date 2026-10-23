import * as THREE from "three";
import { TAC } from "./palette";

function createRangeRing(radius, color = TAC.radius) {
  const points = [];
  const segments = 48;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.01));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false })
  );
}

function attachIndicatorsToAgent(agent, config) {
  const indicators = new THREE.Group();
  indicators.name = "indicators";
  const { boundingBox, crosshair, detectionRadius } = config;

  if (boundingBox) {
    const boxGeometry = new THREE.BoxGeometry(agent.size * 0.35, agent.size * 0.35, agent.size * 0.2);
    const edges = new THREE.EdgesGeometry(boxGeometry);
    const helper = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: TAC.box, transparent: true, opacity: 0.85 })
    );
    helper.position.z = 0.02;
    indicators.add(helper);
  }

  if (crosshair) {
    const len = 0.12;
    const mat = new THREE.LineBasicMaterial({
      color: TAC.crosshair,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const crosshairGroup = new THREE.Group();
    crosshairGroup.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-len, 0, 0.04),
          new THREE.Vector3(len, 0, 0.04),
        ]),
        mat
      ),
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, -len, 0.04),
          new THREE.Vector3(0, len, 0.04),
        ]),
        mat
      )
    );
    indicators.add(crosshairGroup);
  }

  if (detectionRadius) {
    const r = agent.detectionRadius || 0.2;
    const ring = createRangeRing(r, TAC.radius);
    ring.name = "rangeRing";
    // tick marks at N/E/S/W
    const tickMat = new THREE.LineBasicMaterial({
      color: TAC.radius,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const ticks = new THREE.Group();
    [
      [0, r],
      [0, -r],
      [r, 0],
      [-r, 0],
    ].forEach(([x, y]) => {
      const inward = new THREE.Vector3(-x, -y, 0).normalize().multiplyScalar(0.04);
      ticks.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x, y, 0.015),
            new THREE.Vector3(x + inward.x, y + inward.y, 0.015),
          ]),
          tickMat
        )
      );
    });
    indicators.add(ring, ticks);
  }

  indicators.position.copy(agent.position);
  return indicators;
}

function updateAgentIndicators(agent) {
  if (!agent.indicators) return;
  agent.indicators.position.copy(agent.position);

  const ring = agent.indicators.getObjectByName("rangeRing");
  if (ring && agent.detectionRadius) {
    // rebuild if radius changed significantly — scale as cheap update
    const current = ring.geometry.boundingSphere?.radius;
    if (current && Math.abs(current - agent.detectionRadius) > 0.01) {
      ring.scale.setScalar(agent.detectionRadius / (current || agent.detectionRadius));
    }
  }
}

export { attachIndicatorsToAgent, updateAgentIndicators, createRangeRing };
