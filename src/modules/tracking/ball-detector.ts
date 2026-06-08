/**
 * 2D ball detection in a single camera frame using OpenCV.js.
 * Strategy:
 *   1. Convert to grayscale
 *   2. Background subtraction (MOG2) to isolate motion
 *   3. Hough circle transform on motion mask
 *   4. Sub-pixel refinement on strongest candidate
 *
 * Runs in tracking.worker.ts context after GPU heatmap candidate reduction.
 */

import type { BallDetection2D } from '@/types/tracking';

import type { CV } from '../../env';
declare const cv: CV;

/** Pixel radius range expected for a baseball at 10–60 feet range */
const BALL_MIN_RADIUS_PX = 4;
const BALL_MAX_RADIUS_PX = 35;

export class BallDetector {
  private mog2: unknown = null;
  private readonly cameraId: 0 | 1;

  constructor(cameraId: 0 | 1) {
    this.cameraId = cameraId;
  }

  initialize(): void {
    this.mog2 = new cv.BackgroundSubtractorMOG2(500, 16, false);
  }

  /**
   * Detect ball in a single frame.
   * @param frame - ImageBitmap from camera
   * @param frameIndex - Global frame counter
   * @param candidateRegion - Optional GPU-provided ROI [x, y, w, h] to search within
   */
  detect(
    frame: ImageBitmap,
    frameIndex: number,
    candidateRegion?: [number, number, number, number]
  ): BallDetection2D | null {
    if (!this.mog2) throw new Error('BallDetector not initialized');

    const w = frame.width;
    const h = frame.height;

    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(frame, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);

    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    const fgMask = new cv.Mat();
    const blurred = new cv.Mat();
    const circles = new cv.Mat();

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      (this.mog2 as { apply: (a: unknown, b: unknown) => void }).apply(gray, fgMask);

      // Crop to candidate region if provided
      let workMat = fgMask;
      let roiOffset: [number, number] = [0, 0];
      let croppedMat: unknown = null;

      if (candidateRegion) {
        const [rx, ry, rw, rh] = candidateRegion;
        const rect = new cv.Rect(rx, ry, rw, rh);
        croppedMat = gray.roi(rect);
        workMat = croppedMat as typeof fgMask;
        roiOffset = [rx, ry];
      }

      cv.GaussianBlur(workMat, blurred, new cv.Size(5, 5), 1.5);

      cv.HoughCircles(
        blurred,
        circles,
        cv.HOUGH_GRADIENT,
        1,           // dp
        30,          // minDist
        50,          // param1 (Canny high threshold)
        20,          // param2 (accumulator threshold)
        BALL_MIN_RADIUS_PX,
        BALL_MAX_RADIUS_PX
      );

      if (circles.cols === 0) return null;

      // Take the highest-confidence (first) circle
      const cx = circles.data32F[0] + roiOffset[0];
      const cy = circles.data32F[1] + roiOffset[1];
      const r  = circles.data32F[2];

      if (croppedMat) (croppedMat as { delete: () => void }).delete();

      return {
        center: [cx, cy],
        radius: r,
        confidence: Math.min(1, circles.data32F[2] / BALL_MAX_RADIUS_PX),
        cameraId: this.cameraId,
        frameIndex,
        rsCorrected: false,
      };
    } finally {
      src.delete();
      gray.delete();
      fgMask.delete();
      blurred.delete();
      circles.delete();
    }
  }

  dispose(): void {
    this.mog2 = null;
  }
}
