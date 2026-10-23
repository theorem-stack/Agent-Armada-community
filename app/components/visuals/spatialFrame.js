import * as THREE from "three";
import { TAC, elevationColor } from "./palette";
import { sampleField, normalize, TERRAIN_RELIEF, TERRAIN_BASE } from "./heightField";
import { THREE_WIDTH, THREE_HEIGHT, envToWorld, OBJECT_HEIGHTS } from "../../data/globalVars";

/** Large enough that rotated / letterboxed views never flash empty clear-color. */
export const BACKDROP_SCALE = 4;
/**
 * Contain padding when framing the AOI — leaves a frosted margin so the full
 * mission area is visible with breathing room around it.
 */
export const AOI_FIT_PADDING = 1.4;
/**
 * Frosted workspace as a multiple of each AOI axis (width and height scaled
 * independently so non-square maps keep proportional roam room).
 */
export const WORLD_PAN_SCALE = 2.1;

/**
 * Hypsometric terrain mesh built from the shared height field.
 * Relief is baked into the mesh; objects and contours sample the same surface.
 */
export { TERRAIN_RELIEF, TERRAIN_BASE };

export function createTerrain(
  field,
  { width = THREE_WIDTH, height = THREE_HEIGHT, segments = 96 } = {}
) {
  const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
  const pos = geometry.attributes.position;
  const colors = [];
  const relief = field?.relief ?? TERRAIN_RELIEF;
  const base = field?.base ?? TERRAIN_BASE;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = (x + width / 2) / width;
    const v = (y + height / 2) / height;
    const h = sampleField(field, u, 1 - v);
    const t = normalize(field, h);

    pos.setZ(i, base + t * relief);
    const c = elevationColor(t);
    colors.push(c.r, c.g, c.b);
  }

  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  mesh.userData.kind = "terrain";
  return mesh;
}

/**
 * Oversized slate plane so no empty clear-color is ever visible.
 */
export function createBackdrop({
  width = THREE_WIDTH * BACKDROP_SCALE,
  height = THREE_HEIGHT * BACKDROP_SCALE,
    z = -0.35,
} = {}) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: TAC.backdrop })
  );
  mesh.position.z = z;
  mesh.name = "backdrop";
  mesh.userData.kind = "backdrop";
  return mesh;
}

/** Blurred + desaturated hypsometric preview of the AOI for the frosted frame. */
function buildFrostedTerrainTexture(field, resolution = 160) {
  const src = document.createElement("canvas");
  src.width = resolution;
  src.height = resolution;
  const ctx = src.getContext("2d");
  const image = ctx.createImageData(resolution, resolution);

  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1);
      const v = y / (resolution - 1);
      const h = sampleField(field, u, 1 - v);
      const t = normalize(field, h);
      const c = elevationColor(t);
      const gray = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
      // Near-neutral frost — barely tinted paper outside the AOI
      const r = Math.min(1, gray * 0.55 + 0.4);
      const g = Math.min(1, gray * 0.55 + 0.405);
      const b = Math.min(1, gray * 0.55 + 0.415);
      const i = (y * resolution + x) * 4;
      image.data[i] = Math.round(r * 255);
      image.data[i + 1] = Math.round(g * 255);
      image.data[i + 2] = Math.round(b * 255);
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Downscale / upscale for a soft blur without a heavy convolution
  const blur = document.createElement("canvas");
  blur.width = Math.max(24, Math.round(resolution * 0.18));
  blur.height = Math.max(18, Math.round(resolution * 0.18));
  const bctx = blur.getContext("2d");
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(src, 0, 0, blur.width, blur.height);
  ctx.clearRect(0, 0, resolution, resolution);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(blur, 0, 0, resolution, resolution);
  // Second pass for heavier frost
  bctx.clearRect(0, 0, blur.width, blur.height);
  bctx.drawImage(src, 0, 0, blur.width, blur.height);
  ctx.globalAlpha = 0.65;
  ctx.drawImage(blur, 0, 0, resolution, resolution);
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(src);
  if ("colorSpace" in texture) texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Frosted scene frame outside the AOI: blurred, desaturated terrain wash that
 * keeps focus on the crisp mission area without a white paper border.
 */
export function createFrostedSceneFrame(
  field,
  {
    width = THREE_WIDTH,
    height = THREE_HEIGHT,
    feather = 0.45,
    z = -0.08,
  } = {}
) {
  const halfW = width / 2;
  const halfH = height / 2;
  const texture = buildFrostedTerrainTexture(field);
  const mist = new THREE.Color(TAC.void);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uMap: { value: texture },
      uHalf: { value: new THREE.Vector2(halfW, halfH) },
      uFeather: { value: feather },
      uMist: { value: mist },
    },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec2 uHalf;
      uniform float uFeather;
      uniform vec3 uMist;
      varying vec2 vLocal;

      void main() {
        // Terrain UVs over the AOI; clamp so the frame echoes the edge softly
        vec2 uv = vLocal / (uHalf * 2.0) + 0.5;
        uv = clamp(uv, 0.0, 1.0);
        vec3 terrain = texture2D(uMap, uv).rgb;
        vec3 frost = mix(terrain, uMist, 0.62);

        vec2 d = abs(vLocal) - uHalf;
        float outside = max(d.x, d.y);
        // Soft rim: transparent inside AOI, faint paper wash outside
        float alpha = smoothstep(-0.04, uFeather, outside);
        float dist = length(max(d, 0.0));
        alpha = clamp(alpha * (0.42 + 0.22 * smoothstep(0.0, 2.5, dist)), 0.0, 0.72);

        if (alpha < 0.004) discard;
        gl_FragColor = vec4(frost, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width * BACKDROP_SCALE, height * BACKDROP_SCALE),
    material
  );
  mesh.position.z = z;
  mesh.name = "frostedSceneFrame";
  mesh.userData.kind = "backdrop";
  mesh.userData.disposeExtra = () => texture.dispose();
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return mesh;
}

export function createReferenceGrid({
  width = THREE_WIDTH,
  height = THREE_HEIGHT,
  majorDivisions = 8,
  minorDivisions = 4,
} = {}) {
  const group = new THREE.Group();
  group.name = "referenceGrid";

  const halfW = width / 2;
  const halfH = height / 2;
  const z = -0.08;

  const addLines = (divisions, color, opacity) => {
    const points = [];
    for (let i = 0; i <= divisions; i++) {
      const t = i / divisions;
      const x = -halfW + t * width;
      const y = -halfH + t * height;
      points.push(-halfW, y, z, halfW, y, z);
      points.push(x, -halfH, z, x, halfH, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    group.add(new THREE.LineSegments(geo, mat));
  };

  addLines(majorDivisions * minorDivisions, TAC.gridMinor, 0.5);
  addLines(majorDivisions, TAC.gridMajor, 0.8);

  return group;
}

export function createAoiBoundary({ width = THREE_WIDTH, height = THREE_HEIGHT, tick = 0.42 } = {}) {
  const group = new THREE.Group();
  group.name = "aoiBoundary";
  const halfW = width / 2;
  const halfH = height / 2;
  const z = 0.04;

  const borderPoints = [
    -halfW, -halfH, z, halfW, -halfH, z,
    halfW, -halfH, z, halfW, halfH, z,
    halfW, halfH, z, -halfW, halfH, z,
    -halfW, halfH, z, -halfW, -halfH, z,
  ];
  const borderGeo = new THREE.BufferGeometry();
  borderGeo.setAttribute("position", new THREE.Float32BufferAttribute(borderPoints, 3));
  group.add(
    new THREE.LineSegments(
      borderGeo,
      new THREE.LineBasicMaterial({ color: TAC.aoi, transparent: true, opacity: 0.95 })
    )
  );

  const corners = [
    [-halfW, -halfH, 1, 1],
    [halfW, -halfH, -1, 1],
    [halfW, halfH, -1, -1],
    [-halfW, halfH, 1, -1],
  ];
  const tickPoints = [];
  corners.forEach(([cx, cy, sx, sy]) => {
    tickPoints.push(cx, cy, z, cx + sx * tick, cy, z);
    tickPoints.push(cx, cy, z, cx, cy + sy * tick, z);
  });
  const tickGeo = new THREE.BufferGeometry();
  tickGeo.setAttribute("position", new THREE.Float32BufferAttribute(tickPoints, 3));
  group.add(
    new THREE.LineSegments(
      tickGeo,
      new THREE.LineBasicMaterial({ color: TAC.aoiCorner, transparent: true, opacity: 1 })
    )
  );

  return group;
}

export function setupSceneLighting(scene) {
  scene.background = new THREE.Color(TAC.sceneBg);
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(-2, 3, 5);
  const fill = new THREE.DirectionalLight(0xdfe6ec, 0.22);
  fill.position.set(3, -2, 4);
  scene.add(ambient, key, fill);
  return { ambient, key, fill };
}

/**
 * Ortho half-height that contains the full AOI with frosted-frame padding.
 * Used for default view and max zoom-out so the whole mission area is visible.
 */
export function fitCameraSizeToAoi(
  aspect,
  { width = THREE_WIDTH, height = THREE_HEIGHT, padding = AOI_FIT_PADDING } = {}
) {
  const byHeight = height / 2;
  const byWidth = width / (2 * Math.max(aspect, 0.0001));
  return Math.max(byHeight, byWidth) * padding;
}

/** Ortho half-height that covers the viewport (full-bleed; may clip AOI edges). */
export function coverCameraSizeToAoi(
  aspect,
  { width = THREE_WIDTH, height = THREE_HEIGHT, padding = 1.0 } = {}
) {
  const byHeight = height / 2;
  const byWidth = width / (2 * Math.max(aspect, 0.0001));
  return Math.min(byHeight, byWidth) * padding;
}

/**
 * Orthographic pan/zoom/rotate bound to a DOM element.
 * - Left-drag: uses interactionMode ("pan" | "rotate")
 * - Wheel: zoom
 * - Right-drag or Alt+left-drag: always rotate (shortcut)
 */
export function createOrthoControls(
  camera,
  domElement,
  {
    mapRoot = null,
    /** Rectangular scene the operator must be able to reach (AOI half-extents). */
    contentBounds = {
      halfWidth: THREE_WIDTH / 2,
      halfHeight: THREE_HEIGHT / 2,
    },
    /** Frosted workspace half-extents (per-axis; supports non-square maps). */
    bounds = {
      halfWidth: (THREE_WIDTH * WORLD_PAN_SCALE) / 2,
      halfHeight: (THREE_HEIGHT * WORLD_PAN_SCALE) / 2,
    },
    /** Smallest ortho half-height (most zoomed in). */
    minZoom = 0.75,
    /**
     * Largest ortho half-height (most zoomed out). Defaults to AOI contain-fit
     * so the full mission area sits in a frosted frame.
     */
    maxZoom = (nextAspect) => fitCameraSizeToAoi(nextAspect),
    interactionMode = "pan",
    onChange,
    onUserZoom,
    onDragStateChange,
  } = {}
) {
  let cameraSize = (camera.top - camera.bottom) / 2;
  let aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
  let mapYaw = 0;
  let activeMode = null; // drag gesture: "pan" | "rotate"
  let toolMode = interactionMode === "rotate" ? "rotate" : "pan";
  let lastX = 0;
  let lastY = 0;
  let enabled = true;

  const emit = () => onChange?.({ cameraSize, aspect, mapYaw });
  const emitDrag = () =>
    onDragStateChange?.({
      dragging: Boolean(activeMode),
      mode: activeMode || toolMode,
    });

  const maxCameraSize = () => {
    const maxOut =
      typeof maxZoom === "function"
        ? maxZoom(aspect)
        : typeof maxZoom === "number"
          ? maxZoom
          : Infinity;
    // Stay inside the frosted workspace with headroom on both axes.
    const byBounds = Math.min(
      bounds.halfHeight * 0.92,
      (bounds.halfWidth * 0.92) / Math.max(aspect, 0.0001)
    );
    return Math.min(maxOut, byBounds);
  };

  const applyMapYaw = () => {
    if (mapRoot) mapRoot.rotation.z = mapYaw;
  };

  /**
   * Clamp camera centre in map-local space.
   * Each axis is independent so a wide AOI does not steal vertical pan (and
   * vice versa). Limits always allow:
   *  - centering any content point
   *  - sliding the AOI inside an oversized zoomed-out view
   *  - roaming the frosted workspace
   */
  const clampPan = () => {
    const halfViewW = cameraSize * aspect;
    const halfViewH = cameraSize;
    const contentW = contentBounds.halfWidth;
    const contentH = contentBounds.halfHeight;

    const limitX = Math.max(
      contentW, // center any point on the rectangular scene
      halfViewW - contentW, // slide AOI within the viewport when zoomed out
      bounds.halfWidth - halfViewW // keep the view over the frosted workspace
    );
    const limitY = Math.max(
      contentH,
      halfViewH - contentH,
      bounds.halfHeight - halfViewH
    );

    const cos = Math.cos(-mapYaw);
    const sin = Math.sin(-mapYaw);
    const mx = camera.position.x * cos - camera.position.y * sin;
    const my = camera.position.x * sin + camera.position.y * cos;
    const cx = Math.min(limitX, Math.max(-limitX, mx));
    const cy = Math.min(limitY, Math.max(-limitY, my));
    const cosB = Math.cos(mapYaw);
    const sinB = Math.sin(mapYaw);
    camera.position.x = cx * cosB - cy * sinB;
    camera.position.y = cx * sinB + cy * cosB;
  };

  const applyFrustum = () => {
    const maxOut = maxCameraSize();
    cameraSize = Math.min(maxOut, Math.max(minZoom, cameraSize));
    camera.left = -cameraSize * aspect;
    camera.right = cameraSize * aspect;
    camera.top = cameraSize;
    camera.bottom = -cameraSize;
    camera.updateProjectionMatrix();
    clampPan();
    emit();
  };

  const setAspectFromSize = (width, height) => {
    if (height <= 0) return;
    aspect = width / height;
    applyFrustum();
  };

  const setCameraSize = (size) => {
    cameraSize = size;
    applyFrustum();
  };

  const setMapYaw = (yaw) => {
    mapYaw = yaw;
    applyMapYaw();
    clampPan();
    emit();
  };

  const setInteractionMode = (next) => {
    toolMode = next === "rotate" ? "rotate" : "pan";
    if (!activeMode) emitDrag();
  };

  const setEnabled = (next) => {
    enabled = Boolean(next);
    if (!enabled && activeMode) {
      activeMode = null;
      emitDrag();
    }
  };

  const onWheel = (e) => {
    if (!enabled) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    cameraSize = cameraSize * factor;
    onUserZoom?.();
    applyFrustum();
  };

  const onContextMenu = (e) => e.preventDefault();

  const onPointerDown = (e) => {
    if (!enabled) return;
    // Shortcuts always rotate; otherwise left-drag follows the toolbar tool
    const forceRotate = e.button === 2 || (e.button === 0 && e.altKey);
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0 && !forceRotate) {
      activeMode = toolMode;
    } else if (forceRotate) {
      activeMode = "rotate";
    } else {
      return;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    domElement.setPointerCapture?.(e.pointerId);
    emitDrag();
  };

  const onPointerMove = (e) => {
    if (!enabled || !activeMode) return;
    const rect = domElement.getBoundingClientRect();
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (activeMode === "rotate") {
      mapYaw += (dx / Math.max(rect.width, 1)) * Math.PI;
      applyMapYaw();
      clampPan();
      emit();
      return;
    }

    // Screen-aligned pan (mapRoot carries yaw; camera axes stay screen-locked)
    const worldPerPxX = (camera.right - camera.left) / rect.width;
    const worldPerPxY = (camera.top - camera.bottom) / rect.height;
    camera.position.x -= dx * worldPerPxX;
    camera.position.y += dy * worldPerPxY;
    clampPan();
    emit();
  };

  const onPointerUp = (e) => {
    activeMode = null;
    domElement.releasePointerCapture?.(e.pointerId);
    emitDrag();
  };

  domElement.addEventListener("wheel", onWheel, { passive: false });
  domElement.addEventListener("contextmenu", onContextMenu);
  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointerleave", onPointerUp);

  applyFrustum();

  return {
    setAspectFromSize,
    setCameraSize,
    setMapYaw,
    setInteractionMode,
    setEnabled,
    getCameraSize: () => cameraSize,
    getMapYaw: () => mapYaw,
    getInteractionMode: () => toolMode,
    dispose: () => {
      domElement.removeEventListener("wheel", onWheel);
      domElement.removeEventListener("contextmenu", onContextMenu);
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", onPointerUp);
      domElement.removeEventListener("pointerleave", onPointerUp);
    },
  };
}

const ORBIT_MIN_POLAR = (15 * Math.PI) / 180;
const ORBIT_MAX_POLAR = (75 * Math.PI) / 180;
const ORBIT_DEFAULT_POLAR = (48 * Math.PI) / 180;
const ORBIT_DEFAULT_RADIUS = 14;

/**
 * Z-up perspective orbit. Azimuth 0 looks north (+Y) from the south.
 * Left-drag orbits, right-drag pans the target, wheel dollies.
 */
export function createOrbitControls(
  camera,
  domElement,
  {
    contentBounds = {
      halfWidth: THREE_WIDTH / 2,
      halfHeight: THREE_HEIGHT / 2,
    },
    bounds = {
      halfWidth: (THREE_WIDTH * WORLD_PAN_SCALE) / 2,
      halfHeight: (THREE_HEIGHT * WORLD_PAN_SCALE) / 2,
    },
    minDistance = 0.45,
    maxDistance = 28,
    onChange,
    onDragStateChange,
  } = {}
) {
  const target = new THREE.Vector3(0, 0, 0);
  let azimuth = 0;
  let polar = ORBIT_DEFAULT_POLAR;
  let radius = ORBIT_DEFAULT_RADIUS;
  let activeMode = null;
  let lastX = 0;
  let lastY = 0;
  let enabled = false;

  const emit = () => onChange?.({ mapYaw: azimuth, polar, radius });
  const emitDrag = () =>
    onDragStateChange?.({
      dragging: Boolean(activeMode),
      mode: activeMode || "orbit",
    });

  const clampTarget = () => {
    const limitX = Math.max(contentBounds.halfWidth, bounds.halfWidth * 0.85);
    const limitY = Math.max(contentBounds.halfHeight, bounds.halfHeight * 0.85);
    target.x = Math.min(limitX, Math.max(-limitX, target.x));
    target.y = Math.min(limitY, Math.max(-limitY, target.y));
  };

  const apply = () => {
    polar = Math.min(ORBIT_MAX_POLAR, Math.max(ORBIT_MIN_POLAR, polar));
    radius = Math.min(maxDistance, Math.max(minDistance, radius));
    clampTarget();
    const sinP = Math.sin(polar);
    camera.position.set(
      target.x + radius * sinP * Math.sin(azimuth),
      target.y - radius * sinP * Math.cos(azimuth),
      target.z + radius * Math.cos(polar)
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    emit();
  };

  const setAspectFromSize = (width, height) => {
    if (height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const setTarget = (x, y, z = 0) => {
    target.set(x, y, z);
    apply();
  };

  const resetPose = () => {
    azimuth = 0;
    polar = ORBIT_DEFAULT_POLAR;
    radius = ORBIT_DEFAULT_RADIUS;
    apply();
  };

  const setAzimuth = (yaw) => {
    azimuth = yaw;
    apply();
  };

  const setEnabled = (next) => {
    enabled = Boolean(next);
    if (!enabled && activeMode) {
      activeMode = null;
      emitDrag();
    }
  };

  const onWheel = (e) => {
    if (!enabled) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    radius *= factor;
    apply();
  };

  const onContextMenu = (e) => {
    if (!enabled) return;
    e.preventDefault();
  };

  const onPointerDown = (e) => {
    if (!enabled) return;
    if (e.button === 0) activeMode = "orbit";
    else if (e.button === 2 || e.button === 1) activeMode = "pan";
    else return;
    lastX = e.clientX;
    lastY = e.clientY;
    domElement.setPointerCapture?.(e.pointerId);
    emitDrag();
  };

  const onPointerMove = (e) => {
    if (!enabled || !activeMode) return;
    const rect = domElement.getBoundingClientRect();
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (activeMode === "orbit") {
      azimuth -= (dx / Math.max(rect.width, 1)) * Math.PI;
      polar += (dy / Math.max(rect.height, 1)) * Math.PI * 0.7;
      apply();
      return;
    }

    const panScale = radius / Math.max(rect.height, 1);
    const rightX = Math.cos(azimuth);
    const rightY = Math.sin(azimuth);
    const fwdX = -Math.sin(azimuth);
    const fwdY = Math.cos(azimuth);
    target.x -= dx * panScale * rightX + dy * panScale * fwdX;
    target.y -= dx * panScale * rightY + dy * panScale * fwdY;
    apply();
  };

  const onPointerUp = (e) => {
    if (!enabled && !activeMode) return;
    activeMode = null;
    domElement.releasePointerCapture?.(e.pointerId);
    emitDrag();
  };

  domElement.addEventListener("wheel", onWheel, { passive: false });
  domElement.addEventListener("contextmenu", onContextMenu);
  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointerleave", onPointerUp);

  return {
    setAspectFromSize,
    setTarget,
    resetPose,
    setAzimuth,
    setEnabled,
    getMapYaw: () => azimuth,
    getCameraSize: () => radius * Math.tan((22.5 * Math.PI) / 180),
    dispose: () => {
      domElement.removeEventListener("wheel", onWheel);
      domElement.removeEventListener("contextmenu", onContextMenu);
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", onPointerUp);
      domElement.removeEventListener("pointerleave", onPointerUp);
    },
  };
}

/**
 * Operator walk camera, in env meters then WORLD_SCALE.
 * Eye sits ~1/3 of the way up the container so volumes read at human
 * presence (not ant-scale) while still being blocked for the X-ray demo.
 */
const WALK_EYE_HEIGHT = envToWorld(OBJECT_HEIGHTS.container * 0.35);
const WALK_LOOK_AHEAD = envToWorld(12);
const WALK_PITCH_MAX = (55 * Math.PI) / 180;
const WALK_SPEED = envToWorld(110);
const WALK_DEFAULT_PITCH = 0;

/**
 * Ground-level Z-up walk. WASD / arrows move, left-drag looks.
 * Yaw 0 looks north (+Y). Eye height rides `surfaceAt(x, y)` when provided.
 */
export function createWalkControls(
  camera,
  domElement,
  {
    eyeHeight = WALK_EYE_HEIGHT,
    surfaceAt = null,
    bounds = {
      halfWidth: (THREE_WIDTH * WORLD_PAN_SCALE) / 2,
      halfHeight: (THREE_HEIGHT * WORLD_PAN_SCALE) / 2,
    },
    moveSpeed = WALK_SPEED,
    onChange,
    onDragStateChange,
  } = {}
) {
  let x = 0;
  let y = -1.2;
  let yaw = Math.PI;
  let pitch = -0.12;
  let enabled = false;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const keys = new Set();
  let lastTick = 0;

  const emit = () => onChange?.({ mapYaw: yaw });
  const emitDrag = () =>
    onDragStateChange?.({
      dragging,
      mode: dragging ? "look" : "walk",
    });

  const clamp = () => {
    x = Math.min(bounds.halfWidth, Math.max(-bounds.halfWidth, x));
    y = Math.min(bounds.halfHeight, Math.max(-bounds.halfHeight, y));
  };

  const groundZ = () => {
    const z = typeof surfaceAt === "function" ? surfaceAt(x, y) : 0;
    return Number.isFinite(z) ? z : 0;
  };

  const apply = () => {
    clamp();
    pitch = Math.min(WALK_PITCH_MAX, Math.max(-WALK_PITCH_MAX, pitch));
    camera.up.set(0, 0, 1);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const z = groundZ() + eyeHeight;
    camera.position.set(x, y, z);
    camera.lookAt(
      x + Math.sin(yaw) * cp * WALK_LOOK_AHEAD,
      y + Math.cos(yaw) * cp * WALK_LOOK_AHEAD,
      z + sp * WALK_LOOK_AHEAD
    );
    camera.updateMatrixWorld();
    emit();
  };

  const setPose = (nx, ny, nextYaw = Math.PI, nextPitch = WALK_DEFAULT_PITCH) => {
    x = nx;
    y = ny;
    yaw = nextYaw;
    pitch = nextPitch;
    apply();
  };

  const resetPose = () => setPose(0, -1.2, Math.PI, WALK_DEFAULT_PITCH);

  const setAzimuth = (next) => {
    yaw = next;
    apply();
  };

  const setEnabled = (next) => {
    enabled = Boolean(next);
    if (!enabled) {
      keys.clear();
      if (dragging) {
        dragging = false;
        emitDrag();
      }
    } else {
      lastTick = 0;
      apply();
    }
  };

  const setAspectFromSize = (width, height) => {
    if (height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const isTyping = (target) => {
    if (!target || target === domElement) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  };

  const onKeyDown = (e) => {
    if (!enabled || isTyping(e.target)) return;
    if (
      e.code === "KeyW" ||
      e.code === "KeyA" ||
      e.code === "KeyS" ||
      e.code === "KeyD" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown" ||
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight"
    ) {
      e.preventDefault();
      keys.add(e.code);
    }
  };

  const onKeyUp = (e) => {
    keys.delete(e.code);
  };

  const onPointerDown = (e) => {
    if (!enabled || e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    domElement.setPointerCapture?.(e.pointerId);
    emitDrag();
  };

  const onPointerMove = (e) => {
    if (!enabled || !dragging) return;
    const rect = domElement.getBoundingClientRect();
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    yaw -= (dx / Math.max(rect.width, 1)) * Math.PI;
    pitch -= (dy / Math.max(rect.height, 1)) * Math.PI * 0.6;
    apply();
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    domElement.releasePointerCapture?.(e.pointerId);
    emitDrag();
  };

  const onContextMenu = (e) => {
    if (enabled) e.preventDefault();
  };

  const tick = (now) => {
    if (!enabled) {
      lastTick = 0;
      return;
    }
    if (!lastTick) {
      lastTick = now;
      return;
    }
    const dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;
    let fx = 0;
    let fy = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) {
      fx += Math.sin(yaw);
      fy += Math.cos(yaw);
    }
    if (keys.has("KeyS") || keys.has("ArrowDown")) {
      fx -= Math.sin(yaw);
      fy -= Math.cos(yaw);
    }
    if (keys.has("KeyA") || keys.has("ArrowLeft")) {
      fx -= Math.cos(yaw);
      fy += Math.sin(yaw);
    }
    if (keys.has("KeyD") || keys.has("ArrowRight")) {
      fx += Math.cos(yaw);
      fy -= Math.sin(yaw);
    }
    const len = Math.hypot(fx, fy);
    if (len < 1e-6) return;
    x += (fx / len) * moveSpeed * dt;
    y += (fy / len) * moveSpeed * dt;
    apply();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointerleave", onPointerUp);
  domElement.addEventListener("contextmenu", onContextMenu);

  return {
    tick,
    setPose,
    resetPose,
    setAzimuth,
    setEnabled,
    setAspectFromSize,
    getMapYaw: () => yaw,
    getPose: () => ({ x, y, yaw, pitch }),
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", onPointerUp);
      domElement.removeEventListener("pointerleave", onPointerUp);
      domElement.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
