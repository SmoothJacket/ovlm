/**
 * Calibration Worker — ChArUco detection and stereo solve.
 * OpenCV.js is loaded dynamically inside this worker context.
 */

import type { CalibrationRequest, CalibrationResponse } from '@/types/worker-messages';
import type { CalibrationData } from '@/types/calibration';
import { DEFAULT_CHARUCO_CONFIG } from '@/types/calibration';
import { CharucoDetector } from '@/modules/calibration/charuco-detector';
import { StereoSolver } from '@/modules/calibration/stereo-solver';
import type { CharucoDetectionResult } from '@/types/worker-messages';

let opencvReady = false;
let detector0: CharucoDetector | null = null;
let detector1: CharucoDetector | null = null;
let solver: StereoSolver | null = null;

// Accumulated detections from DETECT_CHARUCO calls
const detections0: CharucoDetectionResult[] = [];
const detections1: CharucoDetectionResult[] = [];

function post(msg: CalibrationResponse): void {
  self.postMessage(msg);
}

async function loadOpenCV(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opencvReady) { resolve(); return; }
    // OpenCV.js must be hosted at /opencv.js in the public folder
    importScripts('/opencv.js');
    (self as unknown as { cv: { onRuntimeInitialized: () => void } }).cv.onRuntimeInitialized = () => {
      opencvReady = true;
      resolve();
    };
    setTimeout(() => reject(new Error('OpenCV.js load timeout')), 30_000);
  });
}

self.addEventListener('message', async (event: MessageEvent<CalibrationRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'INIT': {
      try {
        await loadOpenCV();
        detector0 = new CharucoDetector(DEFAULT_CHARUCO_CONFIG);
        detector0.initialize();
        detector1 = new CharucoDetector(DEFAULT_CHARUCO_CONFIG);
        detector1.initialize();
        solver = new StereoSolver(DEFAULT_CHARUCO_CONFIG);
        post({ type: 'READY' });
      } catch (err) {
        post({ type: 'ERROR', message: String(err) });
      }
      break;
    }

    case 'DETECT_CHARUCO': {
      if (!detector0 || !detector1) {
        post({ type: 'ERROR', message: 'Not initialized' });
        break;
      }
      const detector = msg.cameraId === 0 ? detector0 : detector1;
      const result = detector.detect(msg.frame, [msg.frame.width, msg.frame.height]);
      if (result) {
        if (msg.cameraId === 0) detections0.push(result);
        else detections1.push(result);
        post({ type: 'CORNERS_FOUND', result, cameraId: msg.cameraId });
      } else {
        post({ type: 'CORNERS_NONE', cameraId: msg.cameraId });
      }
      break;
    }

    case 'SOLVE_STEREO': {
      if (!solver || !detector0 || !detector1) {
        post({ type: 'ERROR', message: 'Not initialized' });
        break;
      }

      const imageSize: [number, number] = [
        msg.frames0[0]?.width ?? 1920,
        msg.frames0[0]?.height ?? 1080,
      ];

      try {
        // Detect corners in all provided frames
        const allDets0: CharucoDetectionResult[] = [];
        const allDets1: CharucoDetectionResult[] = [];

        for (let i = 0; i < msg.frames0.length; i++) {
          post({ type: 'SOLVE_PROGRESS', framesProcessed: i, total: msg.frames0.length });
          const d0 = detector0.detect(msg.frames0[i], imageSize);
          const d1 = detector1.detect(msg.frames1[i], imageSize);
          if (d0) allDets0.push(d0);
          if (d1) allDets1.push(d1);
        }

        // Calibrate individual cameras
        const cam0Intrinsics = solver.calibrateSingle(allDets0, imageSize);
        const cam1Intrinsics = solver.calibrateSingle(allDets1, imageSize);

        // Match frame pairs and solve stereo
        const matchedPairs = allDets0
          .map((d0, i) => ({ cam0: d0, cam1: allDets1[i] }))
          .filter((p) => p.cam1 !== undefined);

        const { extrinsics, reprojectionError } = solver.solveStereo(
          matchedPairs,
          imageSize,
          cam0Intrinsics,
          cam1Intrinsics
        );

        if (reprojectionError > 2.0) {
          post({ type: 'SOLVE_FAILED', reprojError: reprojectionError, reason: 'High reprojection error — recapture calibration frames' });
          break;
        }

        const calibration: CalibrationData = {
          cam0: cam0Intrinsics,
          cam1: cam1Intrinsics,
          stereo: extrinsics,
          anchors: msg.frames0.length > 0
            ? {
                worldPoints: [[0,0,0],[0.217,0,0],[0.217,0,0.217],[0,0,0.217]],
                capturedAt: Date.now(),
                cameraSerial: ['', ''],
              }
            : { worldPoints: [[0,0,0],[0.217,0,0],[0.217,0,0.217],[0,0,0.217]], capturedAt: Date.now(), cameraSerial: ['', ''] },
          calibratedAt: Date.now(),
          frameCount: matchedPairs.length,
          valid: true,
        };

        post({ type: 'SOLVE_COMPLETE', calibration });
      } catch (err) {
        post({ type: 'ERROR', message: String(err) });
      }
      break;
    }

    case 'SET_ANCHORS':
      // Anchors are stored on the main thread via anchor-store.ts
      break;
  }
});
