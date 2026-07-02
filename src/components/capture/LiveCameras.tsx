import React, { useEffect, useState } from 'react';
import { VideoCanvas } from './VideoCanvas';

interface CameraStream {
  deviceId: string;
  label: string;
  stream: MediaStream;
  width?: number;
  height?: number;
  frameRate?: number;
}

// Labels that identify built-in or wireless cameras to skip.
// OV9281s (and other USB cams) never match any of these.
const BUILTIN_PATTERNS = [
  /facetime/i,
  /built.?in/i,
  /iphone/i,
  /ipad/i,
  /continuity/i,
  /virtual/i,   // OBS virtual camera, etc.
  /obs/i,
];

function isBuiltIn(label: string): boolean {
  return BUILTIN_PATTERNS.some((p) => p.test(label));
}

/** Enumerates USB video input devices and opens a stream for each.
 * Built-in cameras (FaceTime, iPhone Continuity Camera, virtual cams)
 * are excluded — only physically plugged-in cameras are opened. */
function useCameraStreams(): { cameras: CameraStream[]; error: string | null } {
  const [cameras, setCameras] = useState<CameraStream[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let streams: MediaStream[] = [];
    let cancelled = false;

    async function open() {
      try {
        // Unlock device labels — enumerateDevices() returns blank labels
        // until a permission has been granted at least once.
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        probe.getTracks().forEach((t) => t.stop());

        const videoInputs = devices.filter(
          (d) => d.kind === 'videoinput' && !isBuiltIn(d.label),
        );

        if (cancelled) return;

        const opened: CameraStream[] = [];
        for (const [i, device] of videoInputs.entries()) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: device.deviceId } },
            });
            streams.push(stream);
            const settings = stream.getVideoTracks()[0]?.getSettings();
            opened.push({
              deviceId: device.deviceId,
              label: device.label || `CAM ${i}`,
              stream,
              width: settings?.width,
              height: settings?.height,
              frameRate: settings?.frameRate,
            });
          } catch {
            // This device node doesn't actually support capture (e.g. a
            // metadata-only V4L2 node) — skip it.
          }
        }
        if (!cancelled) setCameras(opened);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    open();
    return () => {
      cancelled = true;
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    };
  }, []);

  return { cameras, error };
}

export function LiveCameras(): React.ReactElement {
  const { cameras, error } = useCameraStreams();

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>CAMERAS {cameras.length > 0 && `(${cameras.length})`}</div>
      {error && <div style={styles.error}>Camera access failed: {error}</div>}
      <div style={styles.grid}>
        {cameras.length === 0 && !error && (
          <div style={styles.cell}>
            <VideoCanvas stream={null} label="NO USB CAMERAS DETECTED" />
          </div>
        )}
        {cameras.map((cam) => (
          <div key={cam.deviceId} style={styles.cell}>
            <VideoCanvas
              stream={cam.stream}
              label={`${cam.label}${cam.width ? ` — ${cam.width}×${cam.height} @ ${cam.frameRate?.toFixed(0)}fps` : ''}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#0d0d14',
    border: '1px solid #1a1a2e',
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.1em',
    color: '#b0b4bc',
    marginBottom: 8,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 8,
  },
  cell: {
    position: 'relative',
    aspectRatio: '4 / 3',
  },
  error: {
    fontSize: 11,
    color: '#ff4455',
    marginBottom: 8,
  },
};
