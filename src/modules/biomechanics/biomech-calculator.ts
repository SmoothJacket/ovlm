/**
 * Aggregate biomechanical metrics from a window of pose landmarks.
 */

import type { PoseLandmarks, BiomechData, HipShoulderSeparation, LeadLegBlock, ArmSlot } from '@/types/biomechanics';
import { hipShoulderSeparation, leadKneeFlexion, armSlotAngle } from './joint-angles';

const BALL_MASS_KG = 0.1417;
const SEGMENT_INERTIA_KG_M2 = 0.22; // Approximate torso + bat inertia

/**
 * Compute all biomechanical metrics from a frame window.
 * @param frames - Ordered landmark arrays (oldest first)
 * @param contactFrameIndex - Index within frames of ball-bat contact
 * @param fps - Frame rate (default 960)
 * @param isRightHanded - Batter handedness
 */
export function computeBiomechData(
  frames: PoseLandmarks[],
  contactFrameIndex: number,
  fps = 960,
  isRightHanded = true
): BiomechData {
  const dt = 1 / fps; // seconds per frame

  // ── Hip-Shoulder Separation ──────────────────────────────────
  const separations = frames.map((lm) => hipShoulderSeparation(lm));
  const validSeps = separations.map((v, i) => ({ v, i })).filter((x) => x.v !== null);

  let peakSep = 0;
  let peakIdx = contactFrameIndex;
  for (const { v, i } of validSeps) {
    if (v! > peakSep) { peakSep = v!; peakIdx = i; }
  }

  // Find max hip rotation frame (peak rate of hip vec angle change)
  let maxHipRate = 0;
  let hipPeakFrame = 0;
  for (let i = 1; i < frames.length; i++) {
    const prev = hipShoulderSeparation(frames[i - 1]);
    const curr = hipShoulderSeparation(frames[i]);
    if (prev !== null && curr !== null) {
      const rate = Math.abs(curr - prev) / dt;
      if (rate > maxHipRate) { maxHipRate = rate; hipPeakFrame = i; }
    }
  }

  const hipShoulderSep: HipShoulderSeparation = {
    peakSeparationDeg: Math.round(peakSep * 10) / 10,
    separationAtContact: separations[contactFrameIndex] ?? 0,
    sequenceDelayFrames: Math.max(0, peakIdx - hipPeakFrame),
  };

  // ── Lead Leg Block ───────────────────────────────────────────
  const kneeAngles = frames.map((lm) => leadKneeFlexion(lm, isRightHanded));

  // Landing frame: first frame where knee angle stabilizes (rate drops below threshold)
  let landingFrame = 0;
  for (let i = 1; i < Math.min(contactFrameIndex + 1, kneeAngles.length); i++) {
    const prev = kneeAngles[i - 1];
    const curr = kneeAngles[i];
    if (prev !== null && curr !== null && Math.abs(curr - prev) < 2) {
      landingFrame = i;
      break;
    }
  }

  const contactKnee = kneeAngles[contactFrameIndex] ?? 170;
  const landingKnee = kneeAngles[landingFrame] ?? 170;
  // Stiffness: how much the knee stays extended from landing to contact
  const stiffnessIndex = Math.min(1, Math.max(0, 1 - Math.abs(contactKnee - landingKnee) / 30));

  const leadLeg: LeadLegBlock = {
    kneeFlexionAtContact: Math.round(contactKnee * 10) / 10,
    stiffnessIndex: Math.round(stiffnessIndex * 100) / 100,
    landingFrame,
  };

  // ── Arm Slot ─────────────────────────────────────────────────
  const contactArmSlot = armSlotAngle(frames[contactFrameIndex] ?? {}, isRightHanded) ?? 0;

  const armSlot: ArmSlot = {
    releaseAngleDeg: Math.round(contactArmSlot * 10) / 10,
    consistencyScore: 0.85, // Populated from IndexedDB history in the component layer
  };

  // ── Torque Estimate ──────────────────────────────────────────
  // τ ≈ I * α where α = angular acceleration of shoulder-hip segment
  const hipRates: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = hipShoulderSeparation(frames[i - 1]);
    const curr = hipShoulderSeparation(frames[i]);
    if (prev !== null && curr !== null) {
      hipRates.push(((curr - prev) * Math.PI) / (180 * dt));
    }
  }
  const peakAngVel = hipRates.length > 0 ? Math.max(...hipRates.map(Math.abs)) : 0;
  const torqueNm = SEGMENT_INERTIA_KG_M2 * peakAngVel; // τ = I * ω_peak (approx)

  return {
    landmarks: frames,
    hipShoulderSep,
    leadLeg,
    armSlot,
    contactFrameIndex,
    torqueEstimateNm: Math.round(torqueNm * 10) / 10,
  };
}
