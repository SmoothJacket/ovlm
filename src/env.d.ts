/// <reference types="vite/client" />

/**
 * Ambient type for OpenCV.js loaded via importScripts.
 * Only covers the subset used in this project.
 */
export type { CV };
interface CV {
  // Matrices
  Mat: new () => CVMat;
  MatVector: new () => CVMatVector;
  matFromImageData: (imageData: ImageData) => CVMat;
  matFromArray: (rows: number, cols: number, type: number, data: number[]) => CVMat;

  // ArUco
  aruco_Dictionary: new (id: number) => unknown;
  aruco_CharucoBoard: new (
    squaresX: number, squaresY: number,
    squareLength: number, markerLength: number,
    dictionary: unknown
  ) => unknown;
  aruco_DetectorParameters: new () => unknown;
  detectMarkers: (
    image: CVMat, dictionary: unknown, corners: CVMatVector,
    ids: CVMat, params?: unknown
  ) => void;
  interpolateCornersCharuco: (
    markerCorners: CVMatVector, markerIds: CVMat, image: CVMat,
    board: unknown, charucoCorners: CVMat, charucoIds: CVMat
  ) => number;

  // Calibration
  calibrateCamera: (
    objectPoints: CVMatVector, imagePoints: CVMatVector, imageSize: CVSize,
    cameraMatrix: CVMat, distCoeffs: CVMat, rvecs: CVMatVector, tvecs: CVMatVector
  ) => number;
  stereoCalibrate: (
    objectPoints: CVMatVector,
    imagePoints1: CVMatVector, imagePoints2: CVMatVector,
    cameraMatrix1: CVMat, distCoeffs1: CVMat,
    cameraMatrix2: CVMat, distCoeffs2: CVMat,
    imageSize: CVSize,
    R: CVMat, T: CVMat, E: CVMat, F: CVMat,
    flags?: number
  ) => number;
  CALIB_FIX_INTRINSIC: number;

  // Image processing
  cvtColor: (src: CVMat, dst: CVMat, code: number) => void;
  GaussianBlur: (src: CVMat, dst: CVMat, ksize: CVSize, sigmaX: number) => void;
  Canny: (src: CVMat, dst: CVMat, threshold1: number, threshold2: number) => void;
  HoughCircles: (
    image: CVMat, circles: CVMat, method: number, dp: number,
    minDist: number, param1?: number, param2?: number,
    minRadius?: number, maxRadius?: number
  ) => void;
  HoughLines: (
    image: CVMat, lines: CVMat, rho: number, theta: number, threshold: number
  ) => void;
  BackgroundSubtractorMOG2: new (history?: number, varThreshold?: number, detectShadows?: boolean) => {
    apply: (src: CVMat, dst: CVMat) => void;
  };

  // Color codes
  COLOR_RGBA2GRAY: number;

  // Hough methods
  HOUGH_GRADIENT: number;

  // Type constants
  CV_32FC2: number;
  CV_32FC3: number;
  CV_64F: number;

  // Size / Rect
  Size: new (width: number, height: number) => CVSize;
  Rect: new (x: number, y: number, width: number, height: number) => CVRect;
}

interface CVMat {
  rows: number;
  cols: number;
  data8U: Uint8Array;
  data32F: Float32Array;
  data32S: Int32Array;
  data64F: Float64Array;
  roi: (rect: CVRect) => CVMat;
  delete: () => void;
}

interface CVMatVector {
  push_back: (mat: CVMat) => void;
  delete: () => void;
}

interface CVSize {
  width: number;
  height: number;
}

interface CVRect {
  x: number; y: number; width: number; height: number;
}

// Allow importing WGSL files as raw strings
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
