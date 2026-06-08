/**
 * Rolling Shutter Correction for GoPro MISSION 1.
 *
 * The camera reads rows sequentially. A fast-moving object (baseball ~100mph)
 * will appear sheared: top of ball captured earlier than bottom row.
 *
 * Correction: apply a per-row time offset to the detected 2D center, then
 * linearly interpolate back to "what would a global shutter have seen" at
 * mid-frame time.
 *
 * The shear magnitude in pixels for a ball moving at velocity v (px/µs):
 *   Δy_shear = v_y * SCAN_RATE_US_PER_ROW * row_from_center
 *   Δx_shear = v_x * SCAN_RATE_US_PER_ROW * row_from_center
 *
 * We estimate v from two consecutive frame detections (finite difference).
 */

import { GP3_CONSTANTS } from './gp3-constants';

export interface RSCorrectionInput {
  /** Raw detected center [x, y] in pixels */
  center: [number, number];
  /** Image height in pixels (to compute row offset from center) */
  imageHeight: number;
  /**
   * Pixel velocity [vx, vy] in pixels per microsecond.
   * Pass null to skip correction (first frame, no prior detection).
   */
  velocityPxPerUs: [number, number] | null;
}

export interface RSCorrectionOutput {
  /** Corrected center [x, y] — as if global shutter at mid-frame time */
  correctedCenter: [number, number];
  /** Magnitude of applied correction in pixels */
  correctionMagnitudePx: number;
}

/**
 * Apply rolling-shutter shear compensation to a single 2D ball detection.
 */
export function applyRSCorrection(input: RSCorrectionInput): RSCorrectionOutput {
  const { center, imageHeight, velocityPxPerUs } = input;

  if (!velocityPxPerUs) {
    return { correctedCenter: center, correctionMagnitudePx: 0 };
  }

  const [x, y] = center;
  const [vx, vy] = velocityPxPerUs;
  const { SCAN_RATE_US_PER_ROW } = GP3_CONSTANTS;

  // Row offset from vertical center of frame
  const rowFromCenter = y - imageHeight / 2;

  // Time offset: how much earlier/later was this row read vs mid-frame
  const timeOffsetUs = rowFromCenter * SCAN_RATE_US_PER_ROW;

  // Correction: subtract the motion that occurred during the row-read delay
  const dx = -vx * timeOffsetUs;
  const dy = -vy * timeOffsetUs;

  return {
    correctedCenter: [x + dx, y + dy],
    correctionMagnitudePx: Math.sqrt(dx * dx + dy * dy),
  };
}

/**
 * Compute pixel velocity from two consecutive detections.
 * @param prev - Previous frame center [x, y]
 * @param curr - Current frame center [x, y]
 * @param dtUs - Time delta between frames in microseconds
 */
export function estimateVelocityPxPerUs(
  prev: [number, number],
  curr: [number, number],
  dtUs: number
): [number, number] {
  if (dtUs === 0) return [0, 0];
  return [
    (curr[0] - prev[0]) / dtUs,
    (curr[1] - prev[1]) / dtUs,
  ];
}
