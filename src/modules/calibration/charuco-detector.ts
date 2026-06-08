/**
 * ChArUco board corner detection using OpenCV.js.
 * OpenCV is loaded as a WASM module and exposed on globalThis.cv.
 * This module runs inside the calibration.worker.ts context.
 */

import type { CharucoBoardConfig } from '@/types/calibration';
import type { CharucoDetectionResult } from '@/types/worker-messages';

import type { CV } from '../../env';
declare const cv: CV;

export class CharucoDetector {
  private board: unknown = null;
  private dictionary: unknown = null;
  private params: unknown = null;
  private readonly config: CharucoBoardConfig;

  constructor(config: CharucoBoardConfig) {
    this.config = config;
  }

  initialize(): void {
    const { squaresX, squaresY, squareLength, markerLength, dictionaryId } = this.config;
    this.dictionary = new cv.aruco_Dictionary(dictionaryId);
    this.board = new cv.aruco_CharucoBoard(
      squaresX,
      squaresY,
      squareLength,
      markerLength,
      this.dictionary
    );
    this.params = new cv.aruco_DetectorParameters();
  }

  /**
   * Detect ChArUco corners in a single frame.
   * @param frame - ImageBitmap from camera
   * @param imageSize - [width, height]
   */
  detect(frame: ImageBitmap, imageSize: [number, number]): CharucoDetectionResult | null {
    if (!this.board || !this.dictionary || !this.params) {
      throw new Error('CharucoDetector not initialized');
    }

    const [w, h] = imageSize;
    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(frame, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    // Convert to OpenCV Mat
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const markerCorners = new cv.MatVector();
    const markerIds = new cv.Mat();
    const charucoCorners = new cv.Mat();
    const charucoIds = new cv.Mat();

    try {
      cv.detectMarkers(gray, this.dictionary, markerCorners, markerIds, this.params);

      if (markerIds.rows === 0) {
        return null;
      }

      cv.interpolateCornersCharuco(
        markerCorners,
        markerIds,
        gray,
        this.board,
        charucoCorners,
        charucoIds
      );

      const count = charucoIds.rows;
      if (count < 6) {
        // Require at least 6 corners for a stable solve
        return null;
      }

      const corners = new Float32Array(count * 2);
      const ids = new Int32Array(count);

      for (let i = 0; i < count; i++) {
        corners[i * 2]     = charucoCorners.data32F[i * 2];
        corners[i * 2 + 1] = charucoCorners.data32F[i * 2 + 1];
        ids[i] = charucoIds.data32S[i];
      }

      return { corners, ids, count };
    } finally {
      src.delete();
      gray.delete();
      markerCorners.delete();
      markerIds.delete();
      charucoCorners.delete();
      charucoIds.delete();
    }
  }

  dispose(): void {
    // OpenCV.js objects are garbage-collected; explicit delete not required
    // unless tracking memory pressure.
    this.board = null;
    this.dictionary = null;
    this.params = null;
  }
}
