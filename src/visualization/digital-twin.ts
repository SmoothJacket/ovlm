/**
 * Digital Twin skeleton renderer using Three.js.
 * Renders MediaPipe pose landmarks as a stick figure with joint spheres.
 */

import * as THREE from 'three';
import type { PoseLandmarks, LandmarkName } from '@/types/biomechanics';

// Skeleton connectivity — pairs of landmark names to draw bones
const SKELETON_CONNECTIONS: [LandmarkName, LandmarkName][] = [
  // Torso
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  // Left arm
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  // Right arm
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  // Left leg
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  // Right leg
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  // Head
  ['left_ear', 'right_ear'],
  ['nose', 'left_eye'],
  ['nose', 'right_eye'],
];

const BONE_RADIUS = 0.015;
const JOINT_RADIUS = 0.03;
const SKELETON_SCALE = 1.8; // meters — MediaPipe world landmarks are ~1m tall

export class DigitalTwin {
  private readonly scene: THREE.Scene;
  private group: THREE.Group | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  update(landmarks: PoseLandmarks): void {
    if (this.group) {
      this.scene.remove(this.group);
      this._disposeGroup(this.group);
    }

    this.group = new THREE.Group();

    // Draw bones
    const boneMat = new THREE.MeshPhongMaterial({
      color: 0x00aaff,
      emissive: 0x002244,
      transparent: true,
      opacity: 0.8,
      shininess: 50,
    });
    const jointMat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x88ccff,
      emissiveIntensity: 0.5,
      shininess: 100,
    });

    for (const [nameA, nameB] of SKELETON_CONNECTIONS) {
      const lmA = landmarks[nameA];
      const lmB = landmarks[nameB];
      if (!lmA || !lmB) continue;
      if ((lmA.visibility ?? 1) < 0.3 || (lmB.visibility ?? 1) < 0.3) continue;

      const pA = this._toVec(lmA);
      const pB = this._toVec(lmB);
      const bone = this._makeBone(pA, pB, BONE_RADIUS, boneMat.clone());
      this.group.add(bone);
    }

    // Draw joints
    for (const lm of Object.values(landmarks)) {
      if (!lm || (lm.visibility ?? 1) < 0.4) continue;
      const geo = new THREE.SphereGeometry(JOINT_RADIUS, 8, 8);
      const mesh = new THREE.Mesh(geo, jointMat.clone());
      mesh.position.copy(this._toVec(lm));
      this.group.add(mesh);
    }

    // Offset skeleton to stand at home plate area
    this.group.position.set(-0.5, 0, 0.3);
    this.scene.add(this.group);
  }

  private _toVec(lm: { x: number; y: number; z: number }): THREE.Vector3 {
    // MediaPipe: +Y is down; Three.js: +Y is up. Also scale and invert Y.
    return new THREE.Vector3(
      lm.x * SKELETON_SCALE,
      -lm.y * SKELETON_SCALE + 1.0,
      lm.z * SKELETON_SCALE
    );
  }

  private _makeBone(
    pA: THREE.Vector3,
    pB: THREE.Vector3,
    radius: number,
    mat: THREE.Material
  ): THREE.Mesh {
    const length = pA.distanceTo(pB);
    const geo = new THREE.CylinderGeometry(radius, radius, length, 6, 1);

    const mid = pA.clone().add(pB).multiplyScalar(0.5);
    const dir = pB.clone().sub(pA).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(mid);
    mesh.quaternion.copy(quat);
    return mesh;
  }

  private _disposeGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }

  dispose(): void {
    if (this.group) {
      this.scene.remove(this.group);
      this._disposeGroup(this.group);
      this.group = null;
    }
  }
}
