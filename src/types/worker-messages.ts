/**
 * Worker message discriminated unions.
 * All ImageBitmap values must be transferred (not copied) via postMessage transfer list.
 * All Float32Array / Int32Array buffers that won't be reused should also be transferred.
 */

import type { CalibrationData, HomePlateAnchors } from './calibration';
import type { FramePair, BallDetection2D, BallMeasurement } from './tracking';
import type { PoseLandmarks, BiomechData } from './biomechanics';

// ────────────────────────────────────────────────────────────────
// Tracking Worker
// ────────────────────────────────────────────────────────────────

export type TrackingRequest =
  | { type: 'INIT'; calibration: CalibrationData }
  | { type: 'PROCESS_PAIR'; pair: FramePair }
  | { type: 'FLUSH' }
  | { type: 'RESET' };

export type TrackingResponse =
  | { type: 'READY'; gpuEnabled: boolean }
  | { type: 'DETECTION'; cam0: BallDetection2D; cam1: BallDetection2D | null }
  | { type: 'MEASUREMENT'; result: BallMeasurement }
  | { type: 'NO_BALL'; frameIndex: number }
  | { type: 'ERROR'; message: string };

// ────────────────────────────────────────────────────────────────
// Biomechanics Worker
// ────────────────────────────────────────────────────────────────

export type BiomechRequest =
  | { type: 'INIT' }
  | { type: 'PROCESS_FRAME'; frame: ImageBitmap; frameIndex: number }
  | { type: 'COMPUTE_METRICS'; contactFrameIndex: number }
  | { type: 'RESET' };

export type BiomechResponse =
  | { type: 'READY' }
  | { type: 'LANDMARKS'; landmarks: PoseLandmarks; frameIndex: number }
  | { type: 'BIOMECH_RESULT'; data: BiomechData }
  | { type: 'ERROR'; message: string };

// ────────────────────────────────────────────────────────────────
// Calibration Worker
// ────────────────────────────────────────────────────────────────

export interface CharucoDetectionResult {
  corners: Float32Array;   // interleaved x,y per detected corner
  ids: Int32Array;         // marker ids
  count: number;
}

export type CalibrationRequest =
  | { type: 'INIT' }
  | { type: 'DETECT_CHARUCO'; frame: ImageBitmap; cameraId: 0 | 1 }
  | { type: 'SOLVE_STEREO'; frames0: ImageBitmap[]; frames1: ImageBitmap[] }
  | { type: 'SET_ANCHORS'; data: HomePlateAnchors };

export type CalibrationResponse =
  | { type: 'READY' }
  | { type: 'CORNERS_FOUND'; result: CharucoDetectionResult; cameraId: 0 | 1 }
  | { type: 'CORNERS_NONE'; cameraId: 0 | 1 }
  | { type: 'SOLVE_COMPLETE'; calibration: CalibrationData }
  | { type: 'SOLVE_PROGRESS'; framesProcessed: number; total: number }
  | { type: 'SOLVE_FAILED'; reprojError: number; reason: string }
  | { type: 'ERROR'; message: string };

// ────────────────────────────────────────────────────────────────
// Audio Worker
// ────────────────────────────────────────────────────────────────

export type AudioRequest =
  | { type: 'ARM'; threshold: number; windowMs: number }
  | { type: 'DISARM' }
  | { type: 'SET_SENSITIVITY'; threshold: number };

export type AudioResponse =
  | { type: 'TRIGGERED'; timestamp: number; peakAmplitude: number }
  | { type: 'LEVEL'; rms: number; peak: number }
  | { type: 'ARMED' }
  | { type: 'DISARMED' };
