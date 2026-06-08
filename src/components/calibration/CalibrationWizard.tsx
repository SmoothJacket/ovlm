import React, { useCallback, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import type { CalibrationResponse } from '@/types/worker-messages';
import type { CalibrationData } from '@/types/calibration';

type WizardStep = 'intro' | 'capture' | 'solving' | 'anchor' | 'done' | 'error';

let calWorker: Worker | null = null;
function getCalWorker(): Worker {
  if (!calWorker) {
    calWorker = new Worker(
      new URL('../../workers/calibration.worker.ts', import.meta.url),
      { type: 'module' }
    );
  }
  return calWorker;
}

export function CalibrationWizard(): React.ReactElement {
  const setCalibration = useStore((s) => s.setCalibration);
  const capturedFrameCount = useStore((s) => s.capturedFrameCount);
  const incrementCapturedFrames = useStore((s) => s.incrementCapturedFrames);
  const resetCapturedFrames = useStore((s) => s.resetCapturedFrames);

  const [step, setStep] = useState<WizardStep>('intro');
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [reprojError, setReprojError] = useState(0);

  const frames0Ref = useRef<ImageBitmap[]>([]);
  const frames1Ref = useRef<ImageBitmap[]>([]);
  const videoRef0 = useRef<HTMLVideoElement>(null);
  const videoRef1 = useRef<HTMLVideoElement>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const TARGET_FRAMES = 20;

  const startCapture = useCallback(async () => {
    setStep('capture');
    resetCapturedFrames();
    frames0Ref.current = [];
    frames1Ref.current = [];

    const worker = getCalWorker();
    worker.postMessage({ type: 'INIT' });

    worker.onmessage = (e: MessageEvent<CalibrationResponse>) => {
      const msg = e.data;
      if (msg.type === 'CORNERS_FOUND') {
        incrementCapturedFrames(msg.cameraId);
      } else if (msg.type === 'SOLVE_PROGRESS') {
        setProgress(msg.framesProcessed);
        setProgressTotal(msg.total);
      } else if (msg.type === 'SOLVE_COMPLETE') {
        setCalibration(msg.calibration);
        setReprojError(msg.calibration.stereo.reprojectionError);
        setStep('done');
      } else if (msg.type === 'SOLVE_FAILED') {
        setErrorMsg(`Reprojection error too high (${msg.reprojError.toFixed(2)} px): ${msg.reason}`);
        setStep('error');
      } else if (msg.type === 'ERROR') {
        setErrorMsg(msg.message);
        setStep('error');
      }
    };

    // Capture frames from both cameras at ~2fps
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === 'videoinput');

    const getStream = (idx: number) =>
      navigator.mediaDevices.getUserMedia({
        video: { deviceId: cameras[idx]?.deviceId, width: 1920, height: 1080 },
      });

    const [s0, s1] = await Promise.all([getStream(0), getStream(1)]);

    if (videoRef0.current) { videoRef0.current.srcObject = s0; videoRef0.current.play(); }
    if (videoRef1.current) { videoRef1.current.srcObject = s1; videoRef1.current.play(); }

    captureIntervalRef.current = setInterval(async () => {
      if (frames0Ref.current.length >= TARGET_FRAMES) {
        if (captureIntervalRef.current) clearInterval(captureIntervalRef.current);
        setStep('solving');
        worker.postMessage({
          type: 'SOLVE_STEREO',
          frames0: frames0Ref.current,
          frames1: frames1Ref.current,
        }, [...frames0Ref.current, ...frames1Ref.current]);
        return;
      }

      const cap = async (video: HTMLVideoElement, ref: ImageBitmap[]): Promise<void> => {
        const offscreen = new OffscreenCanvas(video.videoWidth || 1920, video.videoHeight || 1080);
        const ctx = offscreen.getContext('2d')!;
        ctx.drawImage(video, 0, 0);
        const bitmap = await createImageBitmap(offscreen);
        ref.push(bitmap);
        worker.postMessage({ type: 'DETECT_CHARUCO', frame: bitmap, cameraId: ref === frames0Ref.current ? 0 : 1 });
      };

      if (videoRef0.current && videoRef1.current) {
        await Promise.all([
          cap(videoRef0.current, frames0Ref.current),
          cap(videoRef1.current, frames1Ref.current),
        ]);
      }
    }, 500);
  }, [setCalibration, incrementCapturedFrames, resetCapturedFrames]);

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h2 style={styles.title}>Stereo Camera Calibration</h2>
        <div style={styles.subtitle}>ChArUco board • Home plate anchor points</div>
      </div>

      {step === 'intro' && <IntroStep onStart={startCapture} />}
      {step === 'capture' && (
        <CaptureStep
          capturedFrameCount={capturedFrameCount}
          target={TARGET_FRAMES}
          videoRef0={videoRef0}
          videoRef1={videoRef1}
        />
      )}
      {step === 'solving' && (
        <SolvingStep progress={progress} total={progressTotal} />
      )}
      {step === 'done' && <DoneStep reprojError={reprojError} />}
      {step === 'error' && <ErrorStep message={errorMsg} onRetry={() => setStep('intro')} />}
    </div>
  );
}

function IntroStep({ onStart }: { onStart: () => void }) {
  return (
    <div style={styles.stepContainer}>
      <div style={styles.instructionCard}>
        <div style={styles.instructionTitle}>Setup Instructions</div>
        <ol style={styles.instructionList}>
          <li>Print a 7×5 ChArUco board (4×4_50 dictionary) with 4cm squares on A3 paper.</li>
          <li>Mount both GoPro MISSION 1 cameras on rigid tripods, 1.5–3 meters apart.</li>
          <li>Place the ChArUco board flat at home plate, perpendicular to the pitcher-batter line.</li>
          <li>Click <strong>Start Calibration</strong> — slowly tilt and rotate the board across 20 frames.</li>
          <li>After capture, place home plate corners at the board origin for anchor alignment.</li>
        </ol>
      </div>
      <button style={styles.btnLarge} onClick={onStart}>
        ▶ START CALIBRATION
      </button>
    </div>
  );
}

function CaptureStep({
  capturedFrameCount,
  target,
  videoRef0,
  videoRef1,
}: {
  capturedFrameCount: [number, number];
  target: number;
  videoRef0: React.RefObject<HTMLVideoElement | null>;
  videoRef1: React.RefObject<HTMLVideoElement | null>;
}) {
  return (
    <div style={styles.stepContainer}>
      <div style={styles.videoPreviewRow}>
        <div style={styles.previewWrapper}>
          <video ref={videoRef0 as React.RefObject<HTMLVideoElement>} style={styles.previewVideo} playsInline muted />
          <div style={styles.previewBadge}>CAM 0 — {capturedFrameCount[0]}/{target} ✓</div>
        </div>
        <div style={styles.previewWrapper}>
          <video ref={videoRef1 as React.RefObject<HTMLVideoElement>} style={styles.previewVideo} playsInline muted />
          <div style={styles.previewBadge}>CAM 1 — {capturedFrameCount[1]}/{target} ✓</div>
        </div>
      </div>
      <div style={styles.progressBar}>
        <div style={{ ...styles.progressFill, width: `${(Math.min(capturedFrameCount[0], target) / target) * 100}%` }} />
      </div>
      <div style={styles.progressLabel}>
        Slowly move the ChArUco board. Keep it clearly visible in both cameras.
      </div>
    </div>
  );
}

function SolvingStep({ progress, total }: { progress: number; total: number }) {
  return (
    <div style={styles.centeredStep}>
      <div style={styles.spinnerRing} />
      <div style={styles.solvingText}>SOLVING STEREO CALIBRATION</div>
      <div style={styles.solvingSubtext}>
        Processing frame {progress} / {total || '?'} — minimizing reprojection error...
      </div>
    </div>
  );
}

function DoneStep({ reprojError }: { reprojError: number }) {
  return (
    <div style={styles.centeredStep}>
      <div style={{ fontSize: 48 }}>✅</div>
      <div style={{ fontSize: 18, color: '#44ff88', marginTop: 12 }}>Calibration Complete</div>
      <div style={{ fontSize: 12, color: '#667', marginTop: 6 }}>
        Mean reprojection error: <strong style={{ color: '#44aaff' }}>{reprojError.toFixed(3)} px</strong>
        {reprojError < 0.5 && ' — Excellent'}
        {reprojError >= 0.5 && reprojError < 1.0 && ' — Good'}
        {reprojError >= 1.0 && ' — Acceptable'}
      </div>
      <div style={{ fontSize: 11, color: '#445', marginTop: 8 }}>
        Calibration saved to IndexedDB. Switch to Capture to begin.
      </div>
    </div>
  );
}

function ErrorStep({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={styles.centeredStep}>
      <div style={{ fontSize: 42 }}>⚠️</div>
      <div style={{ fontSize: 14, color: '#ff4455', marginTop: 12 }}>Calibration Failed</div>
      <div style={{ fontSize: 11, color: '#667', marginTop: 6, maxWidth: 400, textAlign: 'center' }}>{message}</div>
      <button style={{ ...styles.btnLarge, marginTop: 20 }} onClick={onRetry}>↩ RETRY</button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: 24,
    gap: 16,
    overflow: 'auto',
  },
  header: { marginBottom: 4 },
  title: { fontSize: 18, fontWeight: 700, color: '#aabbd0', margin: 0 },
  subtitle: { fontSize: 11, color: '#445', marginTop: 4, letterSpacing: '0.1em' },
  stepContainer: { display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' },
  centeredStep: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    minHeight: 300,
    gap: 8,
  },
  instructionCard: {
    background: '#0d0d18',
    border: '1px solid #1a1a30',
    borderRadius: 8,
    padding: 20,
    maxWidth: 560,
  },
  instructionTitle: { fontSize: 12, fontWeight: 700, color: '#556', letterSpacing: '0.1em', marginBottom: 12 },
  instructionList: {
    paddingLeft: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    fontSize: 13,
    color: '#889',
    lineHeight: 1.6,
  },
  btnLarge: {
    padding: '10px 28px',
    background: '#001833',
    color: '#66aaff',
    border: '1px solid #1a3a6e',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.12em',
    fontFamily: 'inherit',
  },
  videoPreviewRow: { display: 'flex', gap: 12, width: '100%' },
  previewWrapper: { flex: 1, position: 'relative', background: '#050508', borderRadius: 6, overflow: 'hidden' },
  previewVideo: { width: '100%', display: 'block', maxHeight: 280, objectFit: 'contain' },
  previewBadge: {
    position: 'absolute', bottom: 6, left: 8,
    fontSize: 9, color: '#44ff88', letterSpacing: '0.1em',
    background: 'rgba(0,0,0,0.7)', padding: '2px 6px', borderRadius: 3,
  },
  progressBar: { width: '100%', maxWidth: 560, height: 4, background: '#111', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', background: '#44aaff', transition: 'width 0.4s ease', borderRadius: 2 },
  progressLabel: { fontSize: 11, color: '#556', letterSpacing: '0.05em' },
  solvingText: { fontSize: 13, color: '#44aaff', letterSpacing: '0.15em', marginTop: 12 },
  solvingSubtext: { fontSize: 11, color: '#556', marginTop: 6 },
  spinnerRing: {
    width: 48, height: 48,
    border: '3px solid #111',
    borderTop: '3px solid #44aaff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
};
