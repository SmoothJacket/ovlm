/**
 * Ball tracking and measurement types.
 * All physical units: meters, m/s internally; mph/RPM for display.
 */

export interface FramePair {
  cam0: ImageBitmap;
  cam1: ImageBitmap;
  /** Frame capture timestamp in microseconds */
  timestamp: number;
  frameIndex: number;
}

export interface BallDetection2D {
  /** Sub-pixel center in image coordinates */
  center: [number, number];
  /** Detected radius in pixels */
  radius: number;
  /** Detector confidence 0-1 */
  confidence: number;
  cameraId: 0 | 1;
  frameIndex: number;
  /** Whether rolling-shutter correction was applied */
  rsCorrected: boolean;
}

export interface BallPoint3D {
  x: number; // meters, world frame
  y: number;
  z: number;
  timestamp: number; // microseconds
  disparity?: number;
  reprojError?: number;
}

export interface SeamMeasurement {
  /** Estimated spin rate in RPM */
  spinRate: number;
  /** Spin axis unit vector in world frame */
  spinAxis: [number, number, number];
  /** Ratio of gyro spin to total spin (0-1). 1.0 = pure backspin/topspin */
  spinEfficiency: number;
  /** Frame indices where seam was confidently detected */
  seamFrames: number[];
  /** Confidence of spin measurement 0-1 */
  confidence: number;
}

export interface BallMeasurement {
  /** Ordered 3D positions from contact to ~60 feet */
  trajectory: BallPoint3D[];
  /** Exit velocity in mph */
  exitVelocity: number;
  /** Launch angle in degrees (positive = upward) */
  launchAngle: number;
  /** Spray angle in degrees (0 = center, + = right-center, - = left-center) */
  sprayAngle: number;
  /** Null if seam tracking failed or insufficient frames */
  seam: SeamMeasurement | null;
  /** Frame index of ball-bat contact */
  contactFrameIndex: number;
  /** Wall-clock ms from contact frame receipt to measurement ready */
  processingLatencyMs: number;
  /** Fraction of frames (0–1) where the ball was successfully detected */
  detectRate: number;
  /** Which sensor provided the final exit velocity */
  evSource: 'camera' | 'radar';
  /** Raw radar Doppler speed in mph, null if radar not active */
  radarVelocityMph: number | null;
  /** Pitch speed in mph from OPS243 inbound reading, null if no radar */
  pitchVelocityMph: number | null;
  /** Measured carry distance in metres from OPS243 FMCW, null if unavailable */
  carryDistanceM: number | null;
}

/** Result of the Kalman trajectory filter */
export interface TrajectoryFitResult {
  smoothedPoints: BallPoint3D[];
  /** Fitted velocity vector at contact [vx, vy, vz] m/s */
  initialVelocity: [number, number, number];
  /** RMS residual of fit in meters */
  fitResidualmM: number;
}
