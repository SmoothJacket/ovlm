/**
 * Stereo calibration solver.
 * Wraps OpenCV.js stereoCalibrate to produce intrinsic/extrinsic matrices.
 * Runs in calibration.worker.ts context.
 */

import type { CalibrationData, CharucoBoardConfig, IntrinsicMatrix, StereoExtrinsics } from '@/types/calibration';
import type { CharucoDetectionResult } from '@/types/worker-messages';
import { DEFAULT_CHARUCO_CONFIG } from '@/types/calibration';

import type { CV } from '../../env';
declare const cv: CV;
// Alias for OpenCV Mat returned by cv helper functions
type OCVMat = ReturnType<typeof cv.matFromArray>;

export interface FrameDetections {
  cam0: CharucoDetectionResult;
  cam1: CharucoDetectionResult;
}

export class StereoSolver {
  private readonly config: CharucoBoardConfig;

  constructor(config: CharucoBoardConfig = DEFAULT_CHARUCO_CONFIG) {
    this.config = config;
  }

  /**
   * Solve intrinsics for a single camera from multiple frame detections.
   */
  calibrateSingle(
    detections: CharucoDetectionResult[],
    imageSize: [number, number]
  ): IntrinsicMatrix {
    const objectPoints = new cv.MatVector();
    const imagePoints = new cv.MatVector();

    for (const det of detections) {
      const objPts = this._buildObjectPoints(det.ids);
      const imgPts = cv.matFromArray(det.count, 1, cv.CV_32FC2, Array.from(det.corners));
      objectPoints.push_back(objPts);
      imagePoints.push_back(imgPts);
      objPts.delete();
    }

    const cameraMatrix = new cv.Mat();
    const distCoeffs = new cv.Mat();
    const rvecs = new cv.MatVector();
    const tvecs = new cv.MatVector();
    const imageSize_cv = new cv.Size(imageSize[0], imageSize[1]);

    cv.calibrateCamera(
      objectPoints,
      imagePoints,
      imageSize_cv,
      cameraMatrix,
      distCoeffs,
      rvecs,
      tvecs
    );

    const result: IntrinsicMatrix = {
      fx: cameraMatrix.data64F[0],
      fy: cameraMatrix.data64F[4],
      cx: cameraMatrix.data64F[2],
      cy: cameraMatrix.data64F[5],
      distCoeffs: new Float64Array(Array.from({ length: 5 }, (_, i) => distCoeffs.data64F[i] ?? 0)),
      imageSize,
    };

    // Cleanup
    objectPoints.delete(); imagePoints.delete();
    cameraMatrix.delete(); distCoeffs.delete();
    rvecs.delete(); tvecs.delete();

    return result;
  }

  /**
   * Solve stereo extrinsics given matched frame detections from both cameras.
   * Returns a full CalibrationData object (anchors must be set separately).
   */
  solveStereo(
    matchedDetections: FrameDetections[],
    imageSize: [number, number],
    cam0Intrinsics: IntrinsicMatrix,
    cam1Intrinsics: IntrinsicMatrix
  ): { extrinsics: StereoExtrinsics; reprojectionError: number } {
    const objectPoints = new cv.MatVector();
    const imagePoints0 = new cv.MatVector();
    const imagePoints1 = new cv.MatVector();

    for (const { cam0, cam1 } of matchedDetections) {
      // Use only corners detected in BOTH frames
      const sharedIds = this._intersectIds(cam0.ids, cam1.ids);
      if (sharedIds.length < 6) continue;

      const objPts = this._buildObjectPoints(new Int32Array(sharedIds));
      const imgPts0 = this._extractCorners(cam0, sharedIds);
      const imgPts1 = this._extractCorners(cam1, sharedIds);

      objectPoints.push_back(objPts);
      imagePoints0.push_back(imgPts0);
      imagePoints1.push_back(imgPts1);
      objPts.delete(); imgPts0.delete(); imgPts1.delete();
    }

    const cameraMatrix0 = this._intrinsicToMat(cam0Intrinsics);
    const cameraMatrix1 = this._intrinsicToMat(cam1Intrinsics);
    const distCoeffs0 = this._distToMat(cam0Intrinsics.distCoeffs);
    const distCoeffs1 = this._distToMat(cam1Intrinsics.distCoeffs);
    const R = new cv.Mat();
    const T = new cv.Mat();
    const E = new cv.Mat();
    const F = new cv.Mat();
    const imageSize_cv = new cv.Size(imageSize[0], imageSize[1]);

    const rpe = cv.stereoCalibrate(
      objectPoints,
      imagePoints0,
      imagePoints1,
      cameraMatrix0,
      distCoeffs0,
      cameraMatrix1,
      distCoeffs1,
      imageSize_cv,
      R,
      T,
      E,
      F,
      cv.CALIB_FIX_INTRINSIC
    );

    const extrinsics: StereoExtrinsics = {
      R: new Float64Array(R.data64F),
      T: new Float64Array(T.data64F),
      E: new Float64Array(E.data64F),
      F: new Float64Array(F.data64F),
      baseline: Math.sqrt(T.data64F[0] ** 2 + T.data64F[1] ** 2 + T.data64F[2] ** 2),
      reprojectionError: rpe,
    };

    // Cleanup
    objectPoints.delete(); imagePoints0.delete(); imagePoints1.delete();
    cameraMatrix0.delete(); cameraMatrix1.delete();
    distCoeffs0.delete(); distCoeffs1.delete();
    R.delete(); T.delete(); E.delete(); F.delete();

    return { extrinsics, reprojectionError: rpe };
  }

  /** Build 3D object points for given marker IDs from the board geometry */
  private _buildObjectPoints(ids: Int32Array): OCVMat {
    const { squaresX, squareLength } = this.config;
    const pts: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const col = id % (squaresX - 1);
      const row = Math.floor(id / (squaresX - 1));
      pts.push(col * squareLength, row * squareLength, 0);
    }
    return cv.matFromArray(ids.length, 1, cv.CV_32FC3, pts);
  }

  private _intersectIds(a: Int32Array, b: Int32Array): number[] {
    const setB = new Set(Array.from(b));
    return Array.from(a).filter((id) => setB.has(id));
  }

  private _extractCorners(det: CharucoDetectionResult, ids: number[]): OCVMat {
    const idIndex = new Map(Array.from(det.ids).map((id, i) => [id, i]));
    const pts: number[] = [];
    for (const id of ids) {
      const i = idIndex.get(id)!;
      pts.push(det.corners[i * 2], det.corners[i * 2 + 1]);
    }
    return cv.matFromArray(ids.length, 1, cv.CV_32FC2, pts);
  }

  private _intrinsicToMat(m: IntrinsicMatrix): OCVMat {
    return cv.matFromArray(3, 3, cv.CV_64F, [
      m.fx, 0, m.cx,
      0, m.fy, m.cy,
      0, 0, 1,
    ]);
  }

  private _distToMat(d: Float64Array): OCVMat {
    return cv.matFromArray(1, 5, cv.CV_64F, Array.from(d));
  }
}
