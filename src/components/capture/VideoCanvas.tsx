import React, { useEffect, useRef } from 'react';
import { useOverlays } from '@/state/store';

interface VideoCanvasProps {
  stream: MediaStream | null;
  label: string;
  /** Called for every captured frame — receives transferable ImageBitmap + timestamp */
  onFrame?: (bitmap: ImageBitmap, timestamp: number) => void;
}

export function VideoCanvas({ stream, label, onFrame }: VideoCanvasProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const overlays = useOverlays();

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    video.play().catch(console.warn);

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    const capture = () => {
      rafRef.current = requestAnimationFrame(capture);
      if (video.readyState < 2) return;

      const w = video.videoWidth || canvas.width;
      const h = video.videoHeight || canvas.height;

      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      ctx.drawImage(video, 0, 0, w, h);

      if (onFrame) {
        createImageBitmap(canvas).then((bitmap) => {
          onFrame(bitmap, performance.now() * 1000); // µs
        });
      }
    };

    rafRef.current = requestAnimationFrame(capture);
    return () => cancelAnimationFrame(rafRef.current);
  }, [stream, onFrame]);

  return (
    <div style={styles.wrapper}>
      {/* Hidden video element for stream attachment */}
      <video
        ref={videoRef}
        style={{ display: 'none' }}
        playsInline
        muted
      />
      {/* Visible canvas */}
      <canvas
        ref={canvasRef}
        style={styles.canvas}
        width={1920}
        height={1080}
      />

      {/* No-stream placeholder */}
      {!stream && (
        <div style={styles.placeholder}>
          <div style={styles.placeholderIcon}>📷</div>
          <div style={styles.placeholderText}>{label}</div>
          <div style={styles.placeholderSub}>No signal — connect GoPro MISSION 1</div>
        </div>
      )}

      {/* Label overlay */}
      <div style={styles.label}>{label}</div>

      {/* Detection overlay canvas (drawn by parent when overlays.detections is true) */}
      {overlays.detections && stream && (
        <canvas
          id={`overlay-${label.replace(/\s/g, '-')}`}
          style={styles.overlayCanvas}
          width={1920}
          height={1080}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'relative',
    background: '#050508',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvas: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  overlayCanvas: {
    position: 'absolute',
    top: 0, left: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  placeholder: {
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    color: '#334',
  },
  placeholderIcon: { fontSize: 36 },
  placeholderText: {
    fontSize: 13,
    fontWeight: 600,
    color: '#445',
    letterSpacing: '0.1em',
  },
  placeholderSub: {
    fontSize: 10,
    color: '#334',
    letterSpacing: '0.05em',
  },
  label: {
    position: 'absolute',
    top: 8,
    left: 10,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#556',
    background: 'rgba(0,0,0,0.5)',
    padding: '2px 6px',
    borderRadius: 2,
  },
};
