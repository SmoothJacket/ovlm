/**
 * Tracking Worker — core ball detection + 3D triangulation pipeline.
 *
 * Message flow:
 *   main → INIT(calibration) → READY
 *   main → PROCESS_PAIR(framePair) → DETECTION | NO_BALL
 *   main → FLUSH → MEASUREMENT (after enough frames)
 *   main → RESET → clears state
 */

import type { TrackingRequest, TrackingResponse } from '@/types/worker-messages';
import type { BallDetection2D, BallPoint3D } from '@/types/tracking';
import type { CalibrationData } from '@/types/calibration';
import { BallDetector } from '@/modules/tracking/ball-detector';
import { Triangulator } from '@/modules/tracking/triangulator';
import { TrajectoryFitter } from '@/modules/tracking/trajectory-fitter';
import { SeamTracker } from '@/modules/tracking/seam-tracker';
import { computeBallMetrics, filterTrajectory } from '@/modules/tracking/metrics-calculator';
import { applyRSCorrection, estimateVelocityPxPerUs } from '@/modules/rolling-shutter/rs-corrector';
import { initGPU } from '@/gpu/device';
import { GPUTracker } from '@/gpu/gpu-tracker';

let calibration: CalibrationData | null = null;
let detector0: BallDetector | null = null;
let detector1: BallDetector | null = null;
let triangulator: Triangulator | null = null;
let gpuTracker: GPUTracker | null = null;
let seamTracker: SeamTracker | null = null;
let fitter: TrajectoryFitter | null = null;
let gpuEnabled = false;

// Accumulated raw points between INIT and FLUSH
const rawPoints: BallPoint3D[] = [];
let prevDet0: BallDetection2D | null = null;
let prevDet1: BallDetection2D | null = null;
let prevTimestamp = 0;
let processingStart = 0;

function post(msg: TrackingResponse): void {
  self.postMessage(msg);
}

async function handleInit(cal: CalibrationData): Promise<void> {
  calibration = cal;

  detector0 = new BallDetector(0);
  detector1 = new BallDetector(1);
  detector0.initialize();
  detector1.initialize();

  triangulator = new Triangulator(cal);
  seamTracker = new SeamTracker();
  fitter = new TrajectoryFitter();

  // Attempt GPU init
  const gpuCtx = await initGPU();
  if (gpuCtx) {
    gpuTracker = new GPUTracker(gpuCtx);
    await gpuTracker.initialize(cal);
    gpuEnabled = true;
  }

  post({ type: 'READY', gpuEnabled });
}

async function handleProcessPair(pair: { cam0: ImageBitmap; cam1: ImageBitmap; timestamp: number; frameIndex: number }): Promise<void> {
  if (!detector0 || !detector1 || !triangulator) return;

  const dt = prevTimestamp > 0 ? pair.timestamp - prevTimestamp : 0;
  prevTimestamp = pair.timestamp;

  // ── Ball detection ──────────────────────────────────────────
  let det0 = detector0.detect(pair.cam0, pair.frameIndex);
  let det1 = detector1.detect(pair.cam1, pair.frameIndex);

  if (!det0 || !det1) {
    post({ type: 'NO_BALL', frameIndex: pair.frameIndex });
    return;
  }

  // ── Rolling shutter correction ──────────────────────────────
  const vel0 = prevDet0 && dt > 0
    ? estimateVelocityPxPerUs(prevDet0.center, det0.center, dt)
    : null;
  const vel1 = prevDet1 && dt > 0
    ? estimateVelocityPxPerUs(prevDet1.center, det1.center, dt)
    : null;

  const rs0 = applyRSCorrection({ center: det0.center, imageHeight: pair.cam0.height, velocityPxPerUs: vel0 });
  const rs1 = applyRSCorrection({ center: det1.center, imageHeight: pair.cam1.height, velocityPxPerUs: vel1 });

  det0 = { ...det0, center: rs0.correctedCenter, rsCorrected: true };
  det1 = { ...det1, center: rs1.correctedCenter, rsCorrected: true };

  prevDet0 = det0;
  prevDet1 = det1;

  // ── 3D Triangulation ────────────────────────────────────────
  let point3D: BallPoint3D | null = null;

  if (gpuEnabled && gpuTracker) {
    point3D = await gpuTracker.triangulate(det0, det1, pair.frameIndex);
  }
  if (!point3D) {
    // CPU fallback
    point3D = triangulator.triangulate(det0, det1);
  }

  rawPoints.push(point3D);
  seamTracker?.processFrame(pair.cam0, det0, pair.timestamp);

  post({ type: 'DETECTION', cam0: det0, cam1: det1 });
}

function handleFlush(): void {
  if (!fitter || rawPoints.length < 3) {
    rawPoints.length = 0;
    return;
  }

  const latency = performance.now() - processingStart;
  const fitResult = fitter.fit(rawPoints);
  const seam = seamTracker?.computeSpinMeasurement() ?? null;
  const filtered = filterTrajectory(fitResult.smoothedPoints);
  fitResult.smoothedPoints = filtered;

  const measurement = computeBallMetrics(fitResult, seam, 0, latency);
  post({ type: 'MEASUREMENT', result: measurement });

  rawPoints.length = 0;
  prevDet0 = null;
  prevDet1 = null;
  seamTracker?.reset();
}

self.addEventListener('message', async (event: MessageEvent<TrackingRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'INIT':
      processingStart = performance.now();
      await handleInit(msg.calibration);
      break;
    case 'PROCESS_PAIR':
      if (rawPoints.length === 0) processingStart = performance.now();
      await handleProcessPair(msg.pair);
      break;
    case 'FLUSH':
      handleFlush();
      break;
    case 'RESET':
      rawPoints.length = 0;
      prevDet0 = null;
      prevDet1 = null;
      seamTracker?.reset();
      break;
    default:
      post({ type: 'ERROR', message: `Unknown message type` });
  }
});
