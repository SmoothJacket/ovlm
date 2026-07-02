/**
 * Compute exit velocity, launch angle, and spray angle from
 * the initial velocity vector at ball-bat contact.
 */

import type { BallMeasurement, BallPoint3D, SeamMeasurement, TrajectoryFitResult } from '@/types/tracking';

const M_S_TO_MPH = 2.23694;

/**
 * Convert an initial velocity vector [vx, vy, vz] (m/s, world frame)
 * into display metrics.
 *
 * World frame: +X = first-base line, +Y = vertical, +Z = toward pitcher.
 * The ball travels in the +Z direction after contact.
 */
export function computeBallMetrics(
  fitResult: TrajectoryFitResult,
  seam: SeamMeasurement | null,
  contactFrameIndex: number,
  processingLatencyMs: number
): BallMeasurement {
  const [vx, vy, vz] = fitResult.initialVelocity;

  // Speed in the XZ plane (horizontal)
  const horizontalSpeed = Math.sqrt(vx * vx + vz * vz);
  const totalSpeed = Math.sqrt(vx * vx + vy * vy + vz * vz);

  const exitVelocityMph = totalSpeed * M_S_TO_MPH;

  // Launch angle: elevation above horizontal plane
  const launchAngleDeg = Math.atan2(vy, horizontalSpeed) * (180 / Math.PI);

  // Spray angle: horizontal direction. 0=center, +right, -left (from batter POV)
  // vx positive = toward first base (right for RHH) = positive spray
  const sprayAngleDeg = Math.atan2(vx, vz) * (180 / Math.PI);

  return {
    trajectory: fitResult.smoothedPoints,
    exitVelocity: Math.round(exitVelocityMph * 10) / 10,
    launchAngle: Math.round(launchAngleDeg * 10) / 10,
    sprayAngle: Math.round(sprayAngleDeg * 10) / 10,
    seam,
    contactFrameIndex,
    processingLatencyMs,
    detectRate: 1,
    evSource: 'camera',
    radarOnly:        false,
    radarVelocityMph: null,
    pitchVelocityMph: null,
    carryDistanceM:   null,
    pitch:            null,
  };
}

/** Filter trajectory points to only those after contact and before 60 feet */
export function filterTrajectory(points: BallPoint3D[]): BallPoint3D[] {
  const MAX_Z_M = 18.44; // 60 feet 6 inches (pitcher's mound distance)
  return points.filter((p) => p.z >= 0 && p.z <= MAX_Z_M);
}
