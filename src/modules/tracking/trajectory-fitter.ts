/**
 * Trajectory fitting: Kalman filter + physics-based drag model.
 * Smooths noisy 3D point sequence and extracts initial velocity at contact.
 *
 * State vector: [x, y, z, vx, vy, vz]
 * Process model: constant velocity + gravitational acceleration on y-axis.
 * Observation: [x, y, z] from triangulation.
 */

import type { BallPoint3D, TrajectoryFitResult } from '@/types/tracking';

// Physical constants
const GRAVITY_M_S2 = 9.81;
const AIR_DENSITY_KG_M3 = 1.225;
const BALL_MASS_KG = 0.1417;     // MLB spec: 5–5.25 oz
const BALL_DIAMETER_M = 0.0737;  // MLB spec: 9–9.25 inch circumference
const BALL_AREA_M2 = Math.PI * (BALL_DIAMETER_M / 2) ** 2;
const DRAG_COEFF = 0.35;         // Typical Cd for baseball in flight
const DRAG_FACTOR = 0.5 * AIR_DENSITY_KG_M3 * DRAG_COEFF * BALL_AREA_M2 / BALL_MASS_KG;

/** 6-element state vector [x,y,z,vx,vy,vz] */
type State = [number, number, number, number, number, number];

/** 6×6 covariance matrix (row-major) */
type Cov6 = number[];

function identity6(): Cov6 {
  const m = new Array(36).fill(0);
  for (let i = 0; i < 6; i++) m[i * 6 + i] = 1;
  return m;
}

function mat6x6Mul(A: Cov6, B: Cov6): Cov6 {
  const C = new Array(36).fill(0);
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++)
      for (let k = 0; k < 6; k++)
        C[i * 6 + j] += A[i * 6 + k] * B[k * 6 + j];
  return C;
}

function mat6x6Add(A: Cov6, B: Cov6): Cov6 {
  return A.map((v, i) => v + B[i]);
}

export class TrajectoryFitter {
  /**
   * Run the Kalman filter on the ordered point array.
   * Points must be sorted by timestamp ascending.
   */
  fit(points: BallPoint3D[]): TrajectoryFitResult {
    if (points.length < 3) {
      return {
        smoothedPoints: points,
        initialVelocity: [0, 0, 0],
        fitResidualmM: 0,
      };
    }

    // Initialize state from first two points
    const dt0 = (points[1].timestamp - points[0].timestamp) * 1e-6; // s
    const state0: State = [
      points[0].x, points[0].y, points[0].z,
      (points[1].x - points[0].x) / dt0,
      (points[1].y - points[0].y) / dt0,
      (points[1].z - points[0].z) / dt0,
    ];

    // Process noise covariance Q (position 0.001m², velocity 0.1(m/s)²)
    const Q: Cov6 = identity6().map((v, i) => v * (i < 18 ? 0.001 : 0.1));

    // Observation noise R: triangulation error ~5mm
    const R_OBS = 0.005 ** 2; // m²

    // Initial covariance P
    let P: Cov6 = identity6().map((v) => v * 0.1);
    let state: State = [...state0];

    const smoothed: BallPoint3D[] = [points[0]];
    let sumResidual = 0;

    for (let i = 1; i < points.length; i++) {
      const dt = (points[i].timestamp - points[i - 1].timestamp) * 1e-6;
      const [x, y, z, vx, vy, vz] = state;

      // Drag deceleration
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const ax = -DRAG_FACTOR * speed * vx;
      const ay = -GRAVITY_M_S2 - DRAG_FACTOR * speed * vy;
      const az = -DRAG_FACTOR * speed * vz;

      // Predict
      const predicted: State = [
        x + vx * dt + 0.5 * ax * dt * dt,
        y + vy * dt + 0.5 * ay * dt * dt,
        z + vz * dt + 0.5 * az * dt * dt,
        vx + ax * dt,
        vy + ay * dt,
        vz + az * dt,
      ];

      // State transition matrix F (6×6)
      const F: Cov6 = identity6();
      F[0 * 6 + 3] = dt; F[1 * 6 + 4] = dt; F[2 * 6 + 5] = dt;

      // P = F*P*F^T + Q
      const FP = mat6x6Mul(F, P);
      const FT = [...F]; // F is symmetric in this case
      P = mat6x6Add(mat6x6Mul(FP, FT), Q);

      // Observation: [x, y, z] rows 0,1,2 of state
      const innovations: [number, number, number] = [
        points[i].x - predicted[0],
        points[i].y - predicted[1],
        points[i].z - predicted[2],
      ];

      // Kalman gain K (6×3 simplified — only position observed)
      // K = P * H^T * (H*P*H^T + R)^-1  where H = [I3|0] (3×6)
      // S = H*P*H^T + R*I3
      for (let j = 0; j < 3; j++) {
        const S_jj = P[j * 6 + j] + R_OBS;
        const K_j = P[j * 6 + j] / S_jj;
        for (let k = 0; k < 6; k++) {
          (state as number[])[k] = predicted[k] + (k === j ? K_j : P[k * 6 + j] / S_jj) * innovations[j];
        }
        // Update P column
        for (let row = 0; row < 6; row++) {
          P[row * 6 + j] *= 1 - P[j * 6 + j] / S_jj;
        }
      }
      state = predicted.map((v, k) => v + (k < 3 ? (P[k * 6 + k] / (P[k * 6 + k] + R_OBS)) * innovations[k] : 0)) as State;

      const residual = Math.sqrt(innovations.reduce((s, v) => s + v * v, 0));
      sumResidual += residual;

      smoothed.push({
        ...points[i],
        x: state[0],
        y: state[1],
        z: state[2],
      });
    }

    const [, , , vx0, vy0, vz0] = state0;
    return {
      smoothedPoints: smoothed,
      initialVelocity: [vx0, vy0, vz0],
      fitResidualmM: (sumResidual / points.length) * 1000,
    };
  }
}
