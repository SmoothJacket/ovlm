/**
 * Stereo calibration data types.
 * All matrices stored row-major as Float64Array for full precision.
 * World origin = center of home plate at ground level.
 * Axes: +X = first-base line, +Y = vertical, +Z = toward pitcher.
 */

export interface IntrinsicMatrix {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** Distortion coefficients [k1, k2, p1, p2, k3] */
  distCoeffs: Float64Array;
  imageSize: [number, number]; // [width, height] in pixels
}

export interface StereoExtrinsics {
  /** 3x3 rotation matrix (row-major) from cam1 to cam0 */
  R: Float64Array;
  /** 3x1 translation vector (meters) from cam1 to cam0 */
  T: Float64Array;
  /** 3x3 Essential matrix */
  E: Float64Array;
  /** 3x3 Fundamental matrix */
  F: Float64Array;
  /** Stereo baseline |T| in meters */
  baseline: number;
  /** Mean reprojection error in pixels across calibration frames */
  reprojectionError: number;
}

export interface HomePlateAnchors {
  /**
   * Four corners of home plate in world coordinates (meters).
   * Order: [front-left, front-right, back-right, back-left]
   * from the batter's perspective.
   */
  worldPoints: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
  capturedAt: number; // Unix ms timestamp
  cameraSerial: [string, string]; // cam0 serial, cam1 serial
}

export interface CalibrationData {
  cam0: IntrinsicMatrix;
  cam1: IntrinsicMatrix;
  stereo: StereoExtrinsics;
  anchors: HomePlateAnchors;
  calibratedAt: number; // Unix ms timestamp
  /** Number of valid ChArUco frame pairs used */
  frameCount: number;
  valid: boolean;
}

/** Board configuration for the ChArUco calibration target */
export interface CharucoBoardConfig {
  squaresX: number;
  squaresY: number;
  squareLength: number; // meters
  markerLength: number; // meters
  dictionaryId: number; // DICT_4X4_50 = 0
}

export const DEFAULT_CHARUCO_CONFIG: CharucoBoardConfig = {
  squaresX: 7,
  squaresY: 5,
  squareLength: 0.04,  // 4cm squares
  markerLength: 0.03,  // 3cm markers
  dictionaryId: 0,
};

export type CalibrationState = 'none' | 'in-progress' | 'complete' | 'stale';
