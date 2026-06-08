/**
 * Seam Tracking — Spin Rate & Spin Axis Estimation.
 *
 * Algorithm:
 *   1. For each frame, crop the ball region from the image.
 *   2. Run Canny edge detection on the crop.
 *   3. Fit a "great circle" (projected seam) via Hough Line Transform.
 *   4. Track the seam orientation across frames; angular velocity = spin rate.
 *   5. The seam great-circle axis is the spin axis (perpendicular to seam plane).
 *
 * This runs CPU-side (OpenCV.js) in the tracking worker, supplementing the
 * GPU seam-detect.wgsl which provides faster candidate detection.
 */

import type { BallDetection2D } from '@/types/tracking';
import type { SeamMeasurement } from '@/types/tracking';

import type { CV } from '../../env';
declare const cv: CV;

const FPS_960 = 960;
const CROP_SIZE = 64; // pixels — ball crop for seam analysis

interface SeamFrame {
  frameIndex: number;
  timestamp: number; // µs
  /** Seam orientation angle in radians [0, π) */
  angle: number;
  confidence: number;
}

export class SeamTracker {
  private readonly seamHistory: SeamFrame[] = [];
  private readonly MAX_HISTORY = 60; // ~62.5ms at 960fps

  /**
   * Process a single frame: detect seam and record orientation.
   * @param frame - ImageBitmap from camera
   * @param detection - Ball detection for crop ROI
   * @param timestamp - Frame timestamp in µs
   */
  processFrame(
    frame: ImageBitmap,
    detection: BallDetection2D,
    timestamp: number
  ): void {
    const [cx, cy] = detection.center;
    const r = detection.radius;
    const cropX = Math.max(0, Math.round(cx - r - 4));
    const cropY = Math.max(0, Math.round(cy - r - 4));
    const cropW = Math.min(frame.width - cropX, Math.round(2 * r + 8));
    const cropH = Math.min(frame.height - cropY, Math.round(2 * r + 8));

    if (cropW < 8 || cropH < 8) return;

    const offscreen = new OffscreenCanvas(cropW, cropH);
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(frame, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const imageData = ctx.getImageData(0, 0, cropW, cropH);

    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const lines = new cv.Mat();

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.Canny(gray, edges, 30, 80);
      cv.HoughLines(edges, lines, 1, Math.PI / 180, 10);

      if (lines.rows === 0) return;

      // Collect line angles within ball circle
      const angles: number[] = [];
      for (let i = 0; i < Math.min(lines.rows, 8); i++) {
        const theta = lines.data32F[i * 2 + 1];
        angles.push(theta % Math.PI);
      }

      // Circular mean of angles
      const sinSum = angles.reduce((s, a) => s + Math.sin(2 * a), 0);
      const cosSum = angles.reduce((s, a) => s + Math.cos(2 * a), 0);
      const meanAngle = Math.atan2(sinSum, cosSum) / 2;
      const confidence = Math.min(1, lines.rows / 6);

      this.seamHistory.push({
        frameIndex: detection.frameIndex,
        timestamp,
        angle: meanAngle < 0 ? meanAngle + Math.PI : meanAngle,
        confidence,
      });

      if (this.seamHistory.length > this.MAX_HISTORY) {
        this.seamHistory.shift();
      }
    } finally {
      src.delete(); gray.delete(); edges.delete(); lines.delete();
    }
  }

  /**
   * Compute spin rate from accumulated seam history.
   * Returns null if insufficient data.
   */
  computeSpinMeasurement(): SeamMeasurement | null {
    const confident = this.seamHistory.filter((f) => f.confidence > 0.4);
    if (confident.length < 6) return null;

    // Angular velocity via linear regression of angle vs time
    const n = confident.length;
    const times = confident.map((f) => f.timestamp * 1e-6); // s
    const angles = confident.map((f) => f.angle);

    // Unwrap angle sequence to remove π-jumps
    const unwrapped = [angles[0]];
    for (let i = 1; i < angles.length; i++) {
      let diff = angles[i] - unwrapped[i - 1];
      while (diff > Math.PI / 2) diff -= Math.PI;
      while (diff < -Math.PI / 2) diff += Math.PI;
      unwrapped.push(unwrapped[i - 1] + diff);
    }

    // Linear regression: angle = omega * t + phi
    const tMean = times.reduce((s, t) => s + t, 0) / n;
    const aMean = unwrapped.reduce((s, a) => s + a, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (times[i] - tMean) * (unwrapped[i] - aMean);
      den += (times[i] - tMean) ** 2;
    }
    const omega = den > 0 ? num / den : 0; // rad/s

    // Convert to RPM: seam makes two half-rotations per full revolution
    // omega_seam = 2 * omega_ball, so RPM = omega_seam/(2π) * 60 / 2
    const spinRpm = Math.abs(omega) / (2 * Math.PI) * 60 / 2;

    // Spin axis: perpendicular to the mean seam plane
    // Approximate as world-frame vector based on mean angle
    const meanAngle = aMean % Math.PI;
    const spinAxis: [number, number, number] = [
      Math.cos(meanAngle),
      0,
      Math.sin(meanAngle),
    ];

    return {
      spinRate: Math.round(spinRpm),
      spinAxis,
      spinEfficiency: 0.7, // placeholder — true efficiency requires 3D seam reconstruction
      seamFrames: confident.map((f) => f.frameIndex),
      confidence: confident.length / this.seamHistory.length,
    };
  }

  reset(): void {
    this.seamHistory.length = 0;
  }
}
