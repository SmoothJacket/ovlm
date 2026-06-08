/**
 * Persists CalibrationData to IndexedDB using idb-keyval.
 * Typed arrays are stored as plain arrays (JSON-serializable) and
 * rehydrated on load.
 */

import { get, set, del } from 'idb-keyval';
import type { CalibrationData, IntrinsicMatrix, StereoExtrinsics } from '@/types/calibration';

const CALIBRATION_KEY = 'ovlm:calibration:v1';

/** Serializable form — Float64Arrays become regular arrays */
interface SerializedCalibration {
  cam0: Omit<IntrinsicMatrix, 'distCoeffs'> & { distCoeffs: number[] };
  cam1: Omit<IntrinsicMatrix, 'distCoeffs'> & { distCoeffs: number[] };
  stereo: {
    R: number[]; T: number[]; E: number[]; F: number[];
    baseline: number; reprojectionError: number;
  };
  anchors: CalibrationData['anchors'];
  calibratedAt: number;
  frameCount: number;
  valid: boolean;
}

function serializeIntrinsic(m: IntrinsicMatrix): SerializedCalibration['cam0'] {
  return { ...m, distCoeffs: Array.from(m.distCoeffs) };
}

function deserializeIntrinsic(
  m: SerializedCalibration['cam0']
): IntrinsicMatrix {
  return { ...m, distCoeffs: new Float64Array(m.distCoeffs) };
}

function serializeExtrinsics(e: StereoExtrinsics): SerializedCalibration['stereo'] {
  return {
    R: Array.from(e.R),
    T: Array.from(e.T),
    E: Array.from(e.E),
    F: Array.from(e.F),
    baseline: e.baseline,
    reprojectionError: e.reprojectionError,
  };
}

function deserializeExtrinsics(
  e: SerializedCalibration['stereo']
): StereoExtrinsics {
  return {
    R: new Float64Array(e.R),
    T: new Float64Array(e.T),
    E: new Float64Array(e.E),
    F: new Float64Array(e.F),
    baseline: e.baseline,
    reprojectionError: e.reprojectionError,
  };
}

export async function saveCalibration(data: CalibrationData): Promise<void> {
  const serialized: SerializedCalibration = {
    cam0: serializeIntrinsic(data.cam0),
    cam1: serializeIntrinsic(data.cam1),
    stereo: serializeExtrinsics(data.stereo),
    anchors: data.anchors,
    calibratedAt: data.calibratedAt,
    frameCount: data.frameCount,
    valid: data.valid,
  };
  await set(CALIBRATION_KEY, serialized);
}

export async function loadCalibration(): Promise<CalibrationData | null> {
  const stored = await get<SerializedCalibration>(CALIBRATION_KEY);
  if (!stored) return null;
  return {
    cam0: deserializeIntrinsic(stored.cam0),
    cam1: deserializeIntrinsic(stored.cam1),
    stereo: deserializeExtrinsics(stored.stereo),
    anchors: stored.anchors,
    calibratedAt: stored.calibratedAt,
    frameCount: stored.frameCount,
    valid: stored.valid,
  };
}

export async function clearCalibration(): Promise<void> {
  await del(CALIBRATION_KEY);
}
