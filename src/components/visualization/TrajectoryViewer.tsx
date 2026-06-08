import React, { useEffect, useRef, useCallback } from 'react';
import { useActiveSwing, useStore } from '@/state/store';
import {
  createScene, resizeScene, disposeScene, CAMERA_PRESETS,
  type SceneContext,
} from '@/visualization/three-scene';
import { TrajectoryMesh } from '@/visualization/trajectory-mesh';
import { DigitalTwin } from '@/visualization/digital-twin';
import { StadiumField, STADIUMS } from '@/visualization/stadium-field';

export function TrajectoryViewer(): React.ReactElement {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const sceneRef      = useRef<SceneContext | null>(null);
  const trajectoryRef = useRef<TrajectoryMesh | null>(null);
  const twinRef       = useRef<DigitalTwin | null>(null);
  const stadiumRef    = useRef<StadiumField | null>(null);
  const isDraggingRef = useRef(false);
  const lastMouseRef  = useRef({ x: 0, y: 0 });
  const orbitTargetRef = useRef({ x: 0, y: 1, z: 8 });

  const activeSwing        = useActiveSwing();
  const overlays           = useStore((s) => s.overlaysEnabled);
  const selectedStadiumId  = useStore((s) => s.selectedStadiumId);
  const cameraPreset       = useStore((s) => s.cameraPreset);
  const setStadium         = useStore((s) => s.setStadium);
  const setCameraPreset    = useStore((s) => s.setCameraPreset);

  // Init scene
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = createScene(canvas);
    sceneRef.current      = ctx;
    trajectoryRef.current = new TrajectoryMesh(ctx.scene);
    twinRef.current       = new DigitalTwin(ctx.scene);
    stadiumRef.current    = new StadiumField(ctx.scene);

    const ro = new ResizeObserver(() => {
      if (canvas.parentElement) {
        const { clientWidth, clientHeight } = canvas.parentElement;
        resizeScene(ctx, clientWidth, clientHeight);
        canvas.width  = clientWidth;
        canvas.height = clientHeight;
      }
    });
    ro.observe(canvas.parentElement!);

    return () => {
      ro.disconnect();
      trajectoryRef.current?.dispose();
      twinRef.current?.dispose();
      stadiumRef.current?.dispose();
      disposeScene(ctx);
    };
  }, []);

  // Sync stadium selection
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;

    stadiumRef.current?.setStadium(selectedStadiumId);

    // Hide grid when a stadium is active (the grass plane covers it)
    ctx.gridHelper.visible = selectedStadiumId === null;
  }, [selectedStadiumId]);

  // Sync camera preset
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const preset = CAMERA_PRESETS[cameraPreset];
    ctx.camera.position.set(...preset.pos);
    ctx.camera.lookAt(...preset.target);
    orbitTargetRef.current = { x: preset.target[0], y: preset.target[1], z: preset.target[2] };
  }, [cameraPreset]);

  // Update trajectory
  useEffect(() => {
    if (!activeSwing || !trajectoryRef.current) return;
    trajectoryRef.current.update(activeSwing.ball.trajectory, activeSwing.ball.exitVelocity);

    if (overlays.landmarks && twinRef.current && activeSwing.biomech) {
      const contactLandmarks = activeSwing.biomech.landmarks[activeSwing.biomech.contactFrameIndex];
      if (contactLandmarks) twinRef.current.update(contactLandmarks);
    }
  }, [activeSwing, overlays.landmarks]);

  // Orbit controls
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingRef.current = true;
    lastMouseRef.current  = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current || !sceneRef.current) return;
    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    const cam    = sceneRef.current.camera;
    const target = orbitTargetRef.current;
    const sph    = cartesianToSpherical(
      cam.position.x - target.x,
      cam.position.y - target.y,
      cam.position.z - target.z,
    );
    sph.theta -= dx * 0.008;
    sph.phi   -= dy * 0.008;
    sph.phi    = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi));

    const [nx, ny, nz] = sphericalToCartesian(sph);
    cam.position.set(nx + target.x, ny + target.y, nz + target.z);
    cam.lookAt(target.x, target.y, target.z);
  }, []);

  const handleMouseUp   = useCallback(() => { isDraggingRef.current = false; }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!sceneRef.current) return;
    const cam = sceneRef.current.camera;
    const target = orbitTargetRef.current;
    const dx = cam.position.x - target.x;
    const dy = cam.position.y - target.y;
    const dz = cam.position.z - target.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const scale = 1 + e.deltaY * 0.001;
    const newDist = Math.max(2, Math.min(300, dist * scale));
    const factor  = newDist / dist;
    cam.position.set(target.x + dx * factor, target.y + dy * factor, target.z + dz * factor);
  }, []);

  return (
    <div style={styles.root}>
      <canvas
        ref={canvasRef}
        style={styles.canvas}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* Top-right controls */}
      <div style={styles.controls}>
        <OverlayToggle id="trajectory" label="TRAJECTORY" />
        <OverlayToggle id="landmarks"  label="SKELETON" />
        <OverlayToggle id="seams"      label="SEAM TRACK" />

        <div style={styles.divider} />

        {/* Camera presets */}
        <CameraBtn preset="plate" label="PLATE" current={cameraPreset} onClick={setCameraPreset} />
        <CameraBtn preset="field" label="FIELD" current={cameraPreset} onClick={setCameraPreset} />

        <div style={styles.divider} />

        {/* Stadium selector */}
        <div style={styles.stadiumLabel}>STADIUM</div>
        <select
          style={styles.stadiumSelect}
          value={selectedStadiumId ?? ''}
          onChange={(e) => setStadium(e.target.value || null)}
        >
          <option value="">— none —</option>
          {['AL East', 'AL Central', 'AL West', 'NL East', 'NL Central', 'NL West'].map((div) => {
            const [league, division] = div.split(' ') as ['AL' | 'NL', 'East' | 'Central' | 'West'];
            const group = STADIUMS.filter((s) => s.league === league && s.division === division);
            return (
              <optgroup key={div} label={div}>
                {group.map((s) => (
                  <option key={s.id} value={s.id}>{s.shortName}</option>
                ))}
              </optgroup>
            );
          })}
        </select>

        {selectedStadiumId && (
          <button style={styles.clearBtn} onClick={() => setStadium(null)}>✕ CLEAR</button>
        )}
      </div>

      {/* Metrics overlay */}
      {activeSwing && (
        <div style={styles.metricsOverlay}>
          <OverlayMetric label="EV"   value={`${activeSwing.ball.exitVelocity} mph`} />
          <OverlayMetric label="LA"   value={`${activeSwing.ball.launchAngle}°`} />
          <OverlayMetric label="SA"   value={`${activeSwing.ball.sprayAngle}°`} />
          {activeSwing.ball.seam && (
            <OverlayMetric label="SPIN" value={`${activeSwing.ball.seam.spinRate.toLocaleString()} rpm`} />
          )}
        </div>
      )}

      {/* Stadium info badge */}
      {selectedStadiumId && (() => {
        const s = STADIUMS.find((st) => st.id === selectedStadiumId);
        return s ? (
          <div style={styles.stadiumBadge}>
            <span style={styles.stadiumBadgeName}>{s.name}</span>
            <span style={styles.stadiumBadgeCity}>{s.city}</span>
          </div>
        ) : null;
      })()}

      {!activeSwing && (
        <div style={styles.noSwing}>
          No swing selected — go to Metrics and select a swing.
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OverlayToggle({ id, label }: { id: string; label: string }) {
  const overlays = useStore((s) => s.overlaysEnabled);
  const toggle   = useStore((s) => s.toggleOverlay);
  const active   = overlays[id as keyof typeof overlays] ?? false;
  return (
    <button
      style={{ ...styles.toggleBtn, ...(active ? styles.toggleBtnActive : {}) }}
      onClick={() => toggle(id as keyof typeof overlays)}
    >
      {label}
    </button>
  );
}

function CameraBtn({
  preset, label, current, onClick,
}: {
  preset: 'plate' | 'field';
  label: string;
  current: string;
  onClick: (p: 'plate' | 'field') => void;
}) {
  const active = current === preset;
  return (
    <button
      style={{ ...styles.toggleBtn, ...(active ? styles.camBtnActive : {}) }}
      onClick={() => onClick(preset)}
    >
      {label}
    </button>
  );
}

function OverlayMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.overlayMetric}>
      <span style={styles.overlayLabel}>{label}</span>
      <span style={styles.overlayValue}>{value}</span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cartesianToSpherical(x: number, y: number, z: number) {
  const r = Math.sqrt(x * x + y * y + z * z) || 1e-9;
  return { r, phi: Math.acos(Math.max(-1, Math.min(1, y / r))), theta: Math.atan2(z, x) };
}

function sphericalToCartesian(s: { r: number; phi: number; theta: number }): [number, number, number] {
  return [
    s.r * Math.sin(s.phi) * Math.cos(s.theta),
    s.r * Math.cos(s.phi),
    s.r * Math.sin(s.phi) * Math.sin(s.theta),
  ];
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#060810' },
  canvas: { width: '100%', height: '100%', display: 'block', cursor: 'grab' },
  controls: {
    position: 'absolute', top: 10, right: 10,
    display: 'flex', gap: 4, flexDirection: 'column', alignItems: 'stretch',
    minWidth: 100,
  },
  toggleBtn: {
    padding: '4px 10px', background: 'rgba(10,10,20,0.75)',
    color: '#445', border: '1px solid #1a1a2e', borderRadius: 3, cursor: 'pointer',
    fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'inherit',
    textAlign: 'center',
  },
  toggleBtnActive: { color: '#44aaff', borderColor: '#1a3a6e' },
  camBtnActive: { color: '#ffcc44', borderColor: '#554422' },
  divider: { height: 1, background: '#1a1a2e', margin: '2px 0' },
  stadiumLabel: { fontSize: 8, color: '#334', letterSpacing: '0.12em', fontFamily: 'inherit', textAlign: 'center', paddingTop: 2 },
  stadiumSelect: {
    background: 'rgba(10,10,20,0.85)', color: '#aabbdd', border: '1px solid #1a1a2e',
    borderRadius: 3, fontSize: 9, fontFamily: 'inherit', padding: '3px 4px', cursor: 'pointer',
    width: '100%',
  },
  clearBtn: {
    padding: '3px 6px', background: 'rgba(10,10,20,0.75)', color: '#aa4444',
    border: '1px solid #2e1a1a', borderRadius: 3, cursor: 'pointer',
    fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'inherit',
  },
  metricsOverlay: {
    position: 'absolute', top: 10, left: 10,
    display: 'flex', flexDirection: 'column', gap: 4,
    background: 'rgba(5,5,12,0.8)', border: '1px solid #1a1a2e',
    borderRadius: 6, padding: '8px 12px',
  },
  overlayMetric: { display: 'flex', gap: 10, alignItems: 'baseline' },
  overlayLabel: { fontSize: 8, color: '#445', letterSpacing: '0.1em', width: 32 },
  overlayValue: { fontSize: 14, color: '#aabbdd', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  stadiumBadge: {
    position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(5,5,12,0.85)', border: '1px solid #1a1a2e',
    borderRadius: 6, padding: '6px 16px', textAlign: 'center',
    display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: 'none',
  },
  stadiumBadgeName: { fontSize: 12, color: '#aabbdd', fontWeight: 700, letterSpacing: '0.05em' },
  stadiumBadgeCity: { fontSize: 9, color: '#556', letterSpacing: '0.1em' },
  noSwing: {
    position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
    fontSize: 11, color: '#334', background: 'rgba(5,5,12,0.7)',
    padding: '6px 14px', borderRadius: 4, pointerEvents: 'none',
  },
};
