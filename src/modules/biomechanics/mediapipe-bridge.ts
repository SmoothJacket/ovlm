/**
 * MediaPipe Pose v2 bridge.
 * Initializes the PoseLandmarker and streams landmarks per frame.
 * Runs in biomechanics.worker.ts context.
 */

import {
  PoseLandmarker,
  FilesetResolver,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { PoseLandmarks, LandmarkName, Landmark3D } from '@/types/biomechanics';

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';

const LANDMARK_NAMES: LandmarkName[] = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky',
  'left_index', 'right_index',
  'left_thumb', 'right_thumb',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

export class MediaPipeBridge {
  private landmarker: PoseLandmarker | null = null;

  async initialize(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_CDN);
    this.landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
  }

  /**
   * Run pose detection on a single video frame.
   * @param frame - ImageBitmap from camera
   * @param timestampMs - Frame timestamp in milliseconds
   */
  detectFrame(frame: ImageBitmap, timestampMs: number): PoseLandmarks | null {
    if (!this.landmarker) throw new Error('MediaPipeBridge not initialized');

    const result: PoseLandmarkerResult = this.landmarker.detectForVideo(
      frame,
      timestampMs
    );

    if (!result.landmarks || result.landmarks.length === 0) return null;

    const rawLandmarks = result.worldLandmarks?.[0] ?? result.landmarks[0];
    const parsed: PoseLandmarks = {};

    for (let i = 0; i < LANDMARK_NAMES.length && i < rawLandmarks.length; i++) {
      const lm = rawLandmarks[i];
      const wlm = result.worldLandmarks?.[0]?.[i];
      const landmark: Landmark3D = {
        x: wlm?.x ?? lm.x,
        y: wlm?.y ?? lm.y,
        z: wlm?.z ?? lm.z,
        visibility: lm.visibility ?? 1,
      };
      parsed[LANDMARK_NAMES[i]] = landmark;
    }

    return parsed;
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
