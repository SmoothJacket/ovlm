/**
 * Biomechanical analysis types.
 * Landmark coordinates are in MediaPipe's normalized image space
 * unless explicitly noted as world-frame.
 */

export interface Landmark3D {
  x: number;
  y: number;
  z: number;
  /** MediaPipe visibility score 0-1 */
  visibility: number;
}

/** MediaPipe Pose v2 landmark names (33 landmarks) */
export type LandmarkName =
  | 'nose' | 'left_eye_inner' | 'left_eye' | 'left_eye_outer'
  | 'right_eye_inner' | 'right_eye' | 'right_eye_outer'
  | 'left_ear' | 'right_ear'
  | 'mouth_left' | 'mouth_right'
  | 'left_shoulder' | 'right_shoulder'
  | 'left_elbow' | 'right_elbow'
  | 'left_wrist' | 'right_wrist'
  | 'left_pinky' | 'right_pinky'
  | 'left_index' | 'right_index'
  | 'left_thumb' | 'right_thumb'
  | 'left_hip' | 'right_hip'
  | 'left_knee' | 'right_knee'
  | 'left_ankle' | 'right_ankle'
  | 'left_heel' | 'right_heel'
  | 'left_foot_index' | 'right_foot_index';

export type PoseLandmarks = Partial<Record<LandmarkName, Landmark3D>>;

export interface HipShoulderSeparation {
  /** Maximum separation angle (degrees) in the swing window */
  peakSeparationDeg: number;
  /** Separation angle at ball-bat contact frame */
  separationAtContact: number;
  /** Time (frames) between peak hip rotation and peak shoulder rotation */
  sequenceDelayFrames: number;
}

export interface LeadLegBlock {
  /** Lead knee flexion angle (degrees) at foot-plant */
  kneeFlexionAtContact: number;
  /**
   * Stiffness index 0-1.
   * 1.0 = knee stays fully extended through contact (maximum block).
   * 0.0 = continuous collapse, no block.
   */
  stiffnessIndex: number;
  /** Frame index of foot plant */
  landingFrame: number;
}

export interface ArmSlot {
  /** Elevation angle of the shoulder→wrist vector at bat release (degrees) */
  releaseAngleDeg: number;
  /**
   * Consistency score (0-1) computed as 1 - normalized_std_dev
   * across the most recent N sessions stored in IndexedDB.
   */
  consistencyScore: number;
}

export interface BiomechData {
  /** Per-frame landmark arrays for the swing analysis window */
  landmarks: PoseLandmarks[];
  hipShoulderSep: HipShoulderSeparation;
  leadLeg: LeadLegBlock;
  armSlot: ArmSlot;
  /** Frame index (within landmarks array) of ball-bat contact */
  contactFrameIndex: number;
  /**
   * Estimated rotational torque in N·m.
   * Approximated from angular momentum change: τ ≈ ΔL/Δt
   * using shoulder-hip segment angular velocity and estimated inertia.
   */
  torqueEstimateNm: number;
}

/** Compact summary stored in IndexedDB for arm slot history */
export interface ArmSlotHistoryEntry {
  sessionId: string;
  timestamp: number;
  releaseAngleDeg: number;
}
