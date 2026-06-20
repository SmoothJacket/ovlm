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

/** Enumerates whatever video input devices the browser can see and opens a
 * stream for each. There's no backend video feed (the Python pipeline
 * doesn't stream frames over the websocket) — this talks to the camera
 * hardware directly via getUserMedia, same as any other browser app. */
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
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');

        probe.getTracks().forEach((t) => t.stop());
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
            <VideoCanvas stream={null} label="WAITING FOR CAMERA…" />
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
    color: '#667',
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
