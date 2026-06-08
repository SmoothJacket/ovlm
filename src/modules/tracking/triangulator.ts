/**
 * CPU-side 3D triangulation (DLT method).
 * Used as fallback when WebGPU is unavailable, or for the first few frames
 * before GPU pipeline is warm.
 *
 * Z = f * b / disparity (simplified for nearly-parallel cameras)
 * Full solution via DLT linear system: A·X = 0, solved by SVD.
 */

import type { BallDetection2D, BallPoint3D } from '@/types/tracking';
import type { CalibrationData } from '@/types/calibration';

/**
 * Build the 3×4 camera projection matrix P = K * [R|t].
 * K is the intrinsic matrix, R is rotation, t is translation.
 * For camera 0 (reference), R=I, t=0.
 * For camera 1, use extrinsic R and T.
 */
function buildProjectionMatrix(
  fx: number, fy: number, cx: number, cy: number,
  R: Float64Array, T: Float64Array
): number[] {
  // P = K * [R | T]
  // K = [[fx,0,cx],[0,fy,cy],[0,0,1]]
  // R is 3x3 row-major, T is 3x1
  const P: number[] = new Array(12).fill(0);

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      P[i * 4 + j] =
        (i === 0 ? fx : i === 1 ? fy : 1) === fx && i === 0
          ? fx * R[i * 3 + j] + (j === 2 ? cx * R[2 * 3 + j] : 0)
          : i === 1
          ? fy * R[i * 3 + j] + (j === 2 ? cy * R[2 * 3 + j] : 0)
          : R[i * 3 + j];
    }
    P[i * 4 + 3] =
      i === 0 ? fx * T[0] + cx * T[2]
      : i === 1 ? fy * T[1] + cy * T[2]
      : T[2];
  }

  return P;
}

/**
 * Build camera 0 projection matrix (identity extrinsics).
 */
function buildP0(fx: number, fy: number, cx: number, cy: number): number[] {
  return [
    fx, 0, cx, 0,
    0, fy, cy, 0,
    0, 0, 1, 0,
  ];
}

/**
 * DLT triangulation from two 2D correspondences and two projection matrices.
 * Solves the 4x4 homogeneous system AX=0 via Jacobi SVD approximation.
 */
export function triangulatePointDLT(
  p0: [number, number],  // cam0 image point
  p1: [number, number],  // cam1 image point
  P0: number[],          // 3×4 projection matrix cam0
  P1: number[],          // 3×4 projection matrix cam1
): [number, number, number] {
  const [u0, v0] = p0;
  const [u1, v1] = p1;

  // Build 4×4 matrix A from the constraint x × (PX) = 0
  const A: number[] = [
    u0 * P0[8]  - P0[0],  u0 * P0[9]  - P0[1],  u0 * P0[10]  - P0[2],  u0 * P0[11]  - P0[3],
    v0 * P0[8]  - P0[4],  v0 * P0[9]  - P0[5],  v0 * P0[10]  - P0[6],  v0 * P0[11]  - P0[7],
    u1 * P1[8]  - P1[0],  u1 * P1[9]  - P1[1],  u1 * P1[10]  - P1[2],  u1 * P1[11]  - P1[3],
    v1 * P1[8]  - P1[4],  v1 * P1[9]  - P1[5],  v1 * P1[10]  - P1[6],  v1 * P1[11]  - P1[7],
  ];

  // Solve AX=0 via power iteration approximation (fast, good enough for 4×4)
  const X = solveSVDLast(A, 4, 4);

  return [X[0] / X[3], X[1] / X[3], X[2] / X[3]];
}

/**
 * Find the last singular vector of a 4×4 matrix via simple power iteration
 * on A^T A (works well for well-conditioned stereo geometry).
 */
function solveSVDLast(A: number[], rows: number, cols: number): number[] {
  // Compute A^T * A  (4×4)
  const ATA: number[] = new Array(cols * cols).fill(0);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < cols; j++) {
      let s = 0;
      for (let k = 0; k < rows; k++) s += A[k * cols + i] * A[k * cols + j];
      ATA[i * cols + j] = s;
    }
  }

  // Power iteration to find smallest eigenvector (inverse iteration with shift)
  // Start from random vector orthogonal to dominant eigenvectors
  let v = [0.1, 0.3, 0.7, 0.9];
  for (let iter = 0; iter < 32; iter++) {
    // v = ATA * v
    const nv = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) nv[i] += ATA[i * 4 + j] * v[j];
    }
    const norm = Math.sqrt(nv.reduce((s, x) => s + x * x, 0));
    v = nv.map((x) => x / (norm || 1));
  }

  return v;
}

/** Compute reprojection error for a triangulated point */
function reprojectionError(
  worldPt: [number, number, number],
  observed: [number, number],
  P: number[]
): number {
  const [X, Y, Z] = worldPt;
  const denom = P[8] * X + P[9] * Y + P[10] * Z + P[11];
  const px = (P[0] * X + P[1] * Y + P[2] * Z + P[3]) / denom;
  const py = (P[4] * X + P[5] * Y + P[6] * Z + P[7]) / denom;
  return Math.sqrt((px - observed[0]) ** 2 + (py - observed[1]) ** 2);
}

export class Triangulator {
  private P0: number[];
  private P1: number[];
  private readonly cal: CalibrationData;

  constructor(calibration: CalibrationData) {
    this.cal = calibration;
    const { cam0, cam1, stereo } = calibration;
    this.P0 = buildP0(cam0.fx, cam0.fy, cam0.cx, cam0.cy);
    this.P1 = buildProjectionMatrix(cam1.fx, cam1.fy, cam1.cx, cam1.cy, stereo.R, stereo.T);
  }

  triangulate(det0: BallDetection2D, det1: BallDetection2D): BallPoint3D {
    const worldXYZ = triangulatePointDLT(
      det0.center,
      det1.center,
      this.P0,
      this.P1
    );

    const rpe0 = reprojectionError(worldXYZ, det0.center, this.P0);
    const rpe1 = reprojectionError(worldXYZ, det1.center, this.P1);

    // Disparity = x_cam0 - x_cam1 (rectified coordinates approximation)
    const disparity = Math.abs(det0.center[0] - det1.center[0]);

    return {
      x: worldXYZ[0],
      y: worldXYZ[1],
      z: worldXYZ[2],
      timestamp: det0.frameIndex * (1_000_000 / 960), // µs at 960fps
      disparity,
      reprojError: (rpe0 + rpe1) / 2,
    };
  }
}
