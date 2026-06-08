/**
 * Three.js scene setup.
 * Managed imperatively to avoid per-frame React reconciler overhead.
 */

import * as THREE from 'three';

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  gridHelper: THREE.GridHelper;
  animationId: number;
}

// ── MLB strike zone constants ──────────────────────────────────────────────
// Width:  17 inches = 0.432 m (home plate width)
// Depth:  17 inches = 0.432 m (spans front to back of home plate)
// Bottom: hollow of the knee  → 1.5 ft = 0.457 m
// Top:    midpoint of torso   → 3.5 ft = 1.067 m
const SZ_W      = 0.432;
const SZ_D      = 0.432;
const SZ_BOTTOM = 0.457;
const SZ_TOP    = 1.067;
const SZ_H      = SZ_TOP - SZ_BOTTOM;
const SZ_CX     = 0;                          // centered over plate
const SZ_CY     = (SZ_BOTTOM + SZ_TOP) / 2;  // 0.762 m
const SZ_CZ     = SZ_D / 2;                  // centered over plate depth

// ── Home plate constants ───────────────────────────────────────────────────
// Pentagon: 17" wide, 8.5" sides, 45° angles meeting at the back point.
// Total depth front→tip = 8.5" + 8.5" = 17" = 0.432 m
const PW = 0.216; // half plate width (8.5")
const PS = 0.216; // straight side depth (8.5")
const PT = PW + PS; // distance to tip = 0.432 m

export function createScene(canvas: HTMLCanvasElement): SceneContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setClearColor(0x060810, 1);

  const scene = new THREE.Scene();
  // Extended fog to accommodate full stadium view (outfield walls ~90-130 m)
  scene.fog = new THREE.Fog(0x060810, 100, 250);

  const camera = new THREE.PerspectiveCamera(55, canvas.clientWidth / canvas.clientHeight, 0.1, 300);
  // Default: close-up plate view for trajectory analysis
  camera.position.set(8, 3, -5);
  camera.lookAt(0, 1, 8);

  // Field grid (30 m × 30 m, near-plate reference)
  const gridHelper = new THREE.GridHelper(30, 30, 0x1a2a1a, 0x0d1a0d);
  gridHelper.position.y = -0.01;
  scene.add(gridHelper);

  // ── Home plate ──────────────────────────────────────────────────────────
  // Centered at X=0, front edge at Z=0, back point at Z=PT (0.432 m)
  const plateShape = new THREE.Shape([
    new THREE.Vector2(-PW, 0),
    new THREE.Vector2( PW, 0),
    new THREE.Vector2( PW, PS),
    new THREE.Vector2(0,   PT),
    new THREE.Vector2(-PW, PS),
  ]);
  const plateGeo = new THREE.ShapeGeometry(plateShape);
  plateGeo.rotateX(Math.PI / 2);
  const plateMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, opacity: 0.2, transparent: true, side: THREE.DoubleSide,
  });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.y = 0.005;
  scene.add(plate);

  // ── Strike zone ─────────────────────────────────────────────────────────

  // Semi-transparent fill (the 3D volume of the strike zone)
  const szBox = new THREE.BoxGeometry(SZ_W, SZ_H, SZ_D);
  const szFillMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88, opacity: 0.06, transparent: true, depthWrite: false,
  });
  const szFill = new THREE.Mesh(szBox, szFillMat);
  szFill.position.set(SZ_CX, SZ_CY, SZ_CZ);
  scene.add(szFill);

  // Wireframe edges — full box
  const szEdgesGeo = new THREE.EdgesGeometry(szBox);
  const szEdgesMat = new THREE.LineBasicMaterial({ color: 0x00ff88, opacity: 0.7, transparent: true });
  const szEdges = new THREE.LineSegments(szEdgesGeo, szEdgesMat);
  szEdges.position.set(SZ_CX, SZ_CY, SZ_CZ);
  scene.add(szEdges);

  // Top boundary plane (more visible than the edge alone)
  const szPlaneMat = new THREE.MeshBasicMaterial({
    color: 0x00ff88, opacity: 0.18, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const szPlaneGeo = new THREE.PlaneGeometry(SZ_W, SZ_D);
  szPlaneGeo.rotateX(Math.PI / 2);

  const szTop = new THREE.Mesh(szPlaneGeo, szPlaneMat);
  szTop.position.set(SZ_CX, SZ_TOP, SZ_CZ);
  scene.add(szTop);

  const szBottom = new THREE.Mesh(szPlaneGeo.clone(), szPlaneMat.clone());
  szBottom.position.set(SZ_CX, SZ_BOTTOM, SZ_CZ);
  scene.add(szBottom);

  // Inside/outside half divider (vertical plane at zone center, X=0)
  const szDivMat = new THREE.MeshBasicMaterial({
    color: 0x00ff44, opacity: 0.08, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const szDivGeo = new THREE.PlaneGeometry(SZ_D, SZ_H);
  szDivGeo.rotateY(Math.PI / 2);
  const szDiv = new THREE.Mesh(szDivGeo, szDivMat);
  szDiv.position.set(SZ_CX, SZ_CY, SZ_CZ);
  scene.add(szDiv);

  // Up/down half divider (horizontal plane at zone midpoint)
  const szHalfMat = new THREE.MeshBasicMaterial({
    color: 0x00ff44, opacity: 0.08, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const szHalfGeo = new THREE.PlaneGeometry(SZ_W, SZ_D);
  szHalfGeo.rotateX(Math.PI / 2);
  const szHalf = new THREE.Mesh(szHalfGeo, szHalfMat);
  szHalf.position.set(SZ_CX, SZ_CY, SZ_CZ);
  scene.add(szHalf);

  // ── Lighting ────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x334455, 0.9));
  const dirLight = new THREE.DirectionalLight(0x88aaff, 1.2);
  dirLight.position.set(5, 10, -5);
  scene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0x223344, 0.4);
  fillLight.position.set(-5, 5, 20);
  scene.add(fillLight);

  let animationId = 0;
  const animate = () => {
    animationId = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };
  animate();

  return { scene, camera, renderer, gridHelper, animationId };
}

export function resizeScene(ctx: SceneContext, width: number, height: number): void {
  ctx.camera.aspect = width / height;
  ctx.camera.updateProjectionMatrix();
  ctx.renderer.setSize(width, height);
}

export function disposeScene(ctx: SceneContext): void {
  cancelAnimationFrame(ctx.animationId);
  ctx.renderer.dispose();
}

export const CAMERA_PRESETS = {
  plate: { pos: [8, 3, -5] as [number, number, number], target: [0, 1, 8] as [number, number, number] },
  field: { pos: [30, 50, -60] as [number, number, number], target: [0, 5, 80] as [number, number, number] },
} as const;
