/**
 * Three.js trajectory tube mesh from 3D point array.
 * Updates in-place when new points arrive.
 */

import * as THREE from 'three';
import type { BallPoint3D } from '@/types/tracking';

const TUBE_SEGMENTS = 8;
const TUBE_RADIUS = 0.02; // meters

export class TrajectoryMesh {
  private mesh: THREE.Mesh | null = null;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  update(points: BallPoint3D[], exitVelocityMph: number): void {
    // Remove old mesh
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }

    if (points.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p.x, p.y, p.z))
    );

    const geo = new THREE.TubeGeometry(curve, points.length * 2, TUBE_RADIUS, TUBE_SEGMENTS, false);

    // Color by velocity: blue (slow) → red (fast)
    const colors: number[] = [];
    const totalLen = curve.getLength();
    const color = new THREE.Color();

    for (let i = 0; i < geo.attributes.position.count; i++) {
      const t = i / geo.attributes.position.count;
      // Deceleration model: faster at launch, slower later
      const velNorm = Math.max(0, 1 - t * 0.3);
      color.setHSL(0.67 * (1 - velNorm), 1, 0.5); // blue→red
      colors.push(color.r, color.g, color.b);
    }

    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true,
      shininess: 80,
      transparent: true,
      opacity: 0.85,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    // Add glowing endpoint sphere at contact
    const contactPt = points[0];
    const contactGeo = new THREE.SphereGeometry(0.037, 16, 16); // ~baseball diameter
    const contactMat = new THREE.MeshStandardMaterial({
      color: 0xffdd44,
      emissive: 0xffdd44,
      emissiveIntensity: 0.6,
      roughness: 0.3,
      metalness: 0.1,
    });
    const contactMesh = new THREE.Mesh(contactGeo, contactMat);
    contactMesh.position.set(contactPt.x, contactPt.y, contactPt.z);
    this.scene.add(contactMesh);
  }

  dispose(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
  }
}
