/**
 * Joint angle calculations from MediaPipe pose landmarks.
 * All angles in degrees.
 */

import type { Landmark3D, PoseLandmarks } from '@/types/biomechanics';

/** 3D angle between vectors BA and BC at vertex B (degrees) */
export function angle3D(A: Landmark3D, B: Landmark3D, C: Landmark3D): number {
  const BA = { x: A.x - B.x, y: A.y - B.y, z: A.z - B.z };
  const BC = { x: C.x - B.x, y: C.y - B.y, z: C.z - B.z };
  const dot = BA.x * BC.x + BA.y * BC.y + BA.z * BC.z;
  const magBA = Math.sqrt(BA.x ** 2 + BA.y ** 2 + BA.z ** 2);
  const magBC = Math.sqrt(BC.x ** 2 + BC.y ** 2 + BC.z ** 2);
  if (magBA === 0 || magBC === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (magBA * magBC)))) * (180 / Math.PI);
}

/** Vector from A to B */
function vec(A: Landmark3D, B: Landmark3D): [number, number, number] {
  return [B.x - A.x, B.y - A.y, B.z - A.z];
}

/** Cross product */
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Normalize vector */
function normalize(v: [number, number, number]): [number, number, number] {
  const mag = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  return mag > 0 ? [v[0] / mag, v[1] / mag, v[2] / mag] : [0, 0, 0];
}

/**
 * Hip-Shoulder separation angle.
 * Computed as the angle between the hip segment (left_hip → right_hip)
 * and the shoulder segment (left_shoulder → right_shoulder), projected
 * onto the XZ (horizontal) plane.
 */
export function hipShoulderSeparation(lm: PoseLandmarks): number | null {
  const lh = lm.left_hip;
  const rh = lm.right_hip;
  const ls = lm.left_shoulder;
  const rs = lm.right_shoulder;

  if (!lh || !rh || !ls || !rs) return null;
  if ([lh, rh, ls, rs].some((l) => (l.visibility ?? 1) < 0.4)) return null;

  const hipVec = normalize([rh.x - lh.x, 0, rh.z - lh.z]);
  const shoulderVec = normalize([rs.x - ls.x, 0, rs.z - ls.z]);

  const cosAngle = hipVec[0] * shoulderVec[0] + hipVec[2] * shoulderVec[2];
  return Math.acos(Math.max(-1, Math.min(1, cosAngle))) * (180 / Math.PI);
}

/**
 * Lead knee flexion angle (degrees).
 * For right-handed batters, lead leg = left leg.
 * isRightHanded determines which leg is the "lead" leg.
 */
export function leadKneeFlexion(lm: PoseLandmarks, isRightHanded = true): number | null {
  const hip    = isRightHanded ? lm.left_hip    : lm.right_hip;
  const knee   = isRightHanded ? lm.left_knee   : lm.right_knee;
  const ankle  = isRightHanded ? lm.left_ankle  : lm.right_ankle;

  if (!hip || !knee || !ankle) return null;
  if ([hip, knee, ankle].some((l) => (l.visibility ?? 1) < 0.4)) return null;

  return angle3D(hip, knee, ankle);
}

/**
 * Arm slot: elevation angle of the shoulder→wrist vector.
 * Returns angle in degrees above horizontal.
 */
export function armSlotAngle(lm: PoseLandmarks, isRightHanded = true): number | null {
  const shoulder = isRightHanded ? lm.right_shoulder : lm.left_shoulder;
  const wrist    = isRightHanded ? lm.right_wrist    : lm.left_wrist;

  if (!shoulder || !wrist) return null;
  if ([shoulder, wrist].some((l) => (l.visibility ?? 1) < 0.3)) return null;

  const v = vec(shoulder, wrist);
  const horizontal = Math.sqrt(v[0] ** 2 + v[2] ** 2);
  return Math.atan2(-v[1], horizontal) * (180 / Math.PI);
}
