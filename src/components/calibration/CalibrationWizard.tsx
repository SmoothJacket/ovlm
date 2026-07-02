import React, { useEffect, useState } from 'react';
import { useStore } from '@/state/store';
import { usePipelineStatus, useCalibrationProgress } from '@/state/store';
import { piClient } from '@/ws/client';
import type { CalibrationProgress } from '@/state/session.slice';
import type { CalibrationMode } from '@/state/session-mode.slice';
import { SessionTypeSelector } from '../session/SessionTypeSelector';
import { RubberAlignment } from './RubberAlignment';

// ── Per-mode copy ─────────────────────────────────────────────────────────────

const MODE_COPY: Record<CalibrationMode, {
  label: string;
  subtitle: string;
  placement: string;
}> = {
  hitting: {
    label:     'HITTING',
    subtitle:  'Cameras facing the batter · capturing the ball off the bat',
    placement: 'Aim both cameras at the contact zone so home plate is fully visible '
             + 'in BOTH frames. Click the 5 plate corners in order: FL → FR → MR → BP → ML.',
  },
  pitching: {
    label:     'PITCHING',
    subtitle:  'Cameras behind the catcher · capturing the pitched ball',
    placement: 'Position both cameras behind the catcher looking back at the pitcher, '
             + 'with home plate fully visible in BOTH frames. Click the 5 plate corners '
             + 'in order: FL → FR → MR → BP → ML.',
  },
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CORNER_LABELS = ['FL', 'FR', 'MR', 'BP', 'ML'];
const CORNER_DESCS  = [
  'Front-left (1st base side)',
  'Front-right (3rd base side)',
  'Mid-right corner',
  'Back point (apex)',
  'Mid-left corner',
];

// Home plate SVG vertices — top-down view, 4 px/inch, 4 px margin
// FL(0,0) FR(17,0) MR(17,8.5) BP(8.5,16.97) ML(0,8.5) in inches
const PLATE_SVG_PTS: [number, number][] = [
  [4,  4],   // FL
  [72, 4],   // FR
  [72, 38],  // MR
  [38, 72],  // BP
  [4,  38],  // ML
];

// ── Grade helper ──────────────────────────────────────────────────────────────

function grade(rmsMm: number, reprojPx: number) {
  if (rmsMm < 5  && reprojPx < 1.5) return { label: 'Excellent', color: '#44ff88' };
  if (rmsMm < 15 && reprojPx < 3.0) return { label: 'Good',      color: '#ffaa44' };
  return { label: 'Rough — move plate larger in frame or improve lighting', color: '#ff4455' };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ModeTab({ label, active, calibrated, onClick }: {
  label: string;
  active: boolean;
  calibrated: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 16px',
        background:  active ? '#0a1a2e' : 'transparent',
        color:       active ? '#55aaff' : '#c0c4cc',
        border:      `1px solid ${active ? '#1a3a6e' : '#1a1a2e'}`,
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.1em',
        fontFamily: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {label}
      {calibrated && <span style={{ color: '#44ff88', fontSize: 9 }}>● CAL</span>}
    </button>
  );
}

function CalibBadge({ progress }: { progress: CalibrationProgress | null }) {
  const done       = progress?.state === 'done';
  const collecting = progress?.state === 'collecting';
  const color = done ? '#44ff88' : collecting ? '#44aaff' : '#d0d4dc';
  const dot   = done ? '●' : collecting ? '◌' : '○';
  const label = done ? 'CALIBRATED' : collecting ? 'CALIBRATING' : 'NOT CALIBRATED';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11,
                  fontWeight: 700, color, letterSpacing: '0.1em',
                  background: '#0a0a14', border: `1px solid ${color}22`,
                  borderRadius: 20, padding: '5px 12px' }}>
      <span style={{ fontSize: 9 }}>{dot}</span>
      {label}
    </div>
  );
}

function MeasInput({ label, ftVal, inVal, onChange }: {
  label: string;
  ftVal: number;
  inVal: number;
  onChange: (ft: number, ins: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 9, color: '#d0d4dc', letterSpacing: '0.12em' }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="number" min={0} max={20} value={ftVal}
          onChange={e => onChange(Number(e.target.value), inVal)}
          style={s.numInput}
        />
        <span style={{ fontSize: 11, color: '#c0c4cc' }}>ft</span>
        <input
          type="number" min={0} max={11} value={inVal}
          onChange={e => onChange(ftVal, Number(e.target.value))}
          style={s.numInput}
        />
        <span style={{ fontSize: 11, color: '#c0c4cc' }}>in</span>
      </div>
    </div>
  );
}

function PlateDiagram({ n0, n1 }: { n0: number; n1: number }) {
  const polyPoints = PLATE_SVG_PTS.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg width={76} height={76} viewBox="0 0 76 76" style={{ flexShrink: 0 }}>
      <polygon points={polyPoints} fill="#07090f" stroke="#2a2a4a" strokeWidth={1.5} />
      {PLATE_SVG_PTS.map(([cx, cy], i) => {
        const placed = Math.min(n0, n1) > i;
        const partial = !placed && Math.max(n0, n1) > i;
        const fill = placed ? '#44ff88' : partial ? '#ffaa44' : '#1a1a2e';
        const textFill = placed || partial ? '#000' : '#d0d4dc';
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={6} fill={fill} stroke="#0a0a14" strokeWidth={1} />
            <text x={cx} y={cy + 0.5} textAnchor="middle" dominantBaseline="middle"
                  fontSize={7} fill={textFill} fontWeight="bold">{i + 1}</text>
          </g>
        );
      })}
      {/* Front-edge label */}
      <text x={38} y={-2} textAnchor="middle" fontSize={6} fill="#334">FRONT</text>
      <text x={38} y={80} textAnchor="middle" fontSize={6} fill="#334">PITCHER</text>
    </svg>
  );
}

function ClickableCamFeed({ label, jpeg, corners, onAdd, fps }: {
  label: string;
  jpeg?: string;
  corners: [number, number][];
  onAdd: (x: number, y: number) => void;
  fps?: number;
}) {
  const done = corners.length >= 5;
  const next = corners.length;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (done) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 640;
    const y = ((e.clientY - rect.top) / rect.height) * 480;
    onAdd(x, y);
  };

  const dots = '●'.repeat(corners.length) + '○'.repeat(5 - corners.length);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, color: '#a0a4ac', fontWeight: 700, letterSpacing: '0.08em' }}>
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {fps !== undefined && fps > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
              color: fps >= 200 ? '#44ff88' : fps >= 100 ? '#ffaa44' : '#ff4455',
            }}>
              {fps} fps
            </span>
          )}
          <span style={{ fontSize: 11, color: done ? '#44ff88' : '#d0d4dc',
                         letterSpacing: '0.05em', fontVariantNumeric: 'tabular-nums' }}>
            {dots}
          </span>
        </div>
      </div>
      <div
        style={{
          position: 'relative',
          background: '#060610',
          borderRadius: 5,
          overflow: 'hidden',
          border: done ? '1px solid #1a3a1a' : '1px solid #111122',
          cursor: done ? 'default' : 'crosshair',
          aspectRatio: '4/3',
          userSelect: 'none',
        }}
        onClick={handleClick}
      >
        {jpeg
          ? <img
              src={`data:image/jpeg;base64,${jpeg}`}
              style={{ width: '100%', height: '100%', display: 'block', objectFit: 'fill' }}
              alt={label}
              draggable={false}
            />
          : <div style={{ width: '100%', height: '100%', display: 'flex',
                          alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, color: '#2a2a3a' }}>
              Waiting for camera...
            </div>
        }
        {/* SVG overlay — coordinate space matches image pixels (640×480) */}
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                   pointerEvents: 'none' }}
          viewBox="0 0 640 480"
        >
          {/* Lines connecting placed corners */}
          {corners.length > 1 && (
            <polyline
              points={corners.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke="#44ff8860"
              strokeWidth={1.5}
            />
          )}
          {/* Corner dots */}
          {corners.map(([x, y], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={9} fill="#44ff88cc" stroke="#fff" strokeWidth={1.5} />
              <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle"
                    fontSize={10} fill="#001a00" fontWeight="bold">{i + 1}</text>
            </g>
          ))}
          {/* Next-corner prompt */}
          {!done && (
            <text x={320} y={462} textAnchor="middle" fontSize={12} fill="#55ccffaa">
              Click {next + 1}: {CORNER_LABELS[next]}
            </text>
          )}
          {done && (
            <text x={320} y={462} textAnchor="middle" fontSize={12} fill="#44ff88aa">
              5 / 5 corners placed
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const discrete = total > 1;
  const pct = discrete
    ? Math.min(100, Math.round((current / total) * 100))
    : 0;
  return (
    <div style={s.progressWrap}>
      {discrete
        ? null
        : <style>{`
            @keyframes _indeterminate {
              0%   { transform: translateX(-100%); }
              100% { transform: translateX(450%); }
            }`}
          </style>
      }
      <div style={s.progressTrack}>
        {discrete
          ? <div style={{ ...s.progressFill, width: `${pct}%` }} />
          : <div style={{
              ...s.progressFill,
              width: '20%',
              animation: '_indeterminate 1.4s ease-in-out infinite',
            }} />
        }
      </div>
      <div style={s.progressLabel}>
        {discrete ? `${current} / ${total} samples` : 'Solving…'}
      </div>
    </div>
  );
}

function ResultCard({ progress }: { progress: CalibrationProgress }) {
  if (!progress.rmsMm || !progress.reprojPx || !progress.baselineMm) return null;
  const { label, color } = grade(progress.rmsMm, progress.reprojPx);
  return (
    <div style={s.resultCard}>
      <div style={s.resultMetrics}>
        <ResultMetric label="BASELINE"  value={progress.baselineMm.toFixed(1)} unit="mm" />
        <div style={s.divider} />
        <ResultMetric label="PLATE RMS" value={progress.rmsMm.toFixed(1)}      unit="mm" />
        <div style={s.divider} />
        <ResultMetric label="REPROJ"    value={progress.reprojPx.toFixed(2)}   unit="px" />
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color, marginTop: 8 }}>✓ {label}</div>
    </div>
  );
}

function ResultMetric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 9, color: '#d0d4dc', letterSpacing: '0.12em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#321', fontVariantNumeric: 'tabular-nums' }}>
        {value}<span style={{ fontSize: 10, color: '#c0c4cc', marginLeft: 3 }}>{unit}</span>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function CalibrationWizard(): React.ReactElement {
  const [corners0, setCorners0] = useState<[number, number][]>([]);
  const [corners1, setCorners1] = useState<[number, number][]>([]);

  const { wsConnected } = usePipelineStatus();
  const progress  = useCalibrationProgress();
  const lastFrame = useStore((s) => s.lastFrame);
  const piHealth  = useStore((s) => s.piHealth);
  const heightFt  = useStore((s) => s.heightFt);
  const heightIn  = useStore((s) => s.heightIn);
  const distFt    = useStore((s) => s.distFt);
  const distIn    = useStore((s) => s.distIn);
  const radarBehindFt = useStore((s) => s.radarBehindFt);
  const radarBehindIn = useStore((s) => s.radarBehindIn);
  const radarHeightFt = useStore((s) => s.radarHeightFt);
  const radarHeightIn = useStore((s) => s.radarHeightIn);
  const setCalibMeasurements = useStore((s) => s.setCalibMeasurements);
  const setRadarPosition     = useStore((s) => s.setRadarPosition);

  const calibrationMode    = useStore((s) => s.calibrationMode);
  const setCalibrationMode = useStore((s) => s.setCalibrationMode);
  const hittingCalibrated  = useStore((s) => s.hittingCalibrated);
  const pitchingCalibrated = useStore((s) => s.pitchingCalibrated);
  const pitchingCalibStep  = useStore((s) => s.pitchingCalibStep);
  const modeCopy = MODE_COPY[calibrationMode];

  const collecting = progress?.state === 'collecting';
  // Only treat the progress as "done" for the mode we're currently editing —
  // otherwise switching modes would carry over the other mode's result card.
  const done       = progress?.state === 'done'
                  && (progress?.mode ?? calibrationMode) === calibrationMode;
  const error      = progress?.state === 'error';

  const can0      = corners0.length === 5;
  const can1      = corners1.length === 5;
  const canSubmit = wsConnected && can0 && can1 && !collecting;

  const addCorner = (cam: 0 | 1, x: number, y: number) => {
    if (cam === 0) setCorners0(prev => prev.length < 5 ? [...prev, [x, y]] : prev);
    else           setCorners1(prev => prev.length < 5 ? [...prev, [x, y]] : prev);
  };

  const resetCorners = () => { setCorners0([]); setCorners1([]); };

  // Clear corners once the backend finishes (success or fail), not before.
  useEffect(() => {
    if (progress?.state === 'done' || progress?.state === 'error') {
      setCorners0([]);
      setCorners1([]);
    }
  }, [progress?.state]);

  const calibrate = () => {
    const heightMm      = (heightFt * 12 + heightIn) * 25.4;
    const distanceMm    = (distFt   * 12 + distIn)   * 25.4;
    const radarBehindMm = (radarBehindFt * 12 + radarBehindIn) * 25.4;
    const radarHeightMm = (radarHeightFt * 12 + radarHeightIn) * 25.4;
    piClient.send({
      type: 'calib_manual',
      corners0, corners1, heightMm, distanceMm,
      mode: calibrationMode,
      radarBehindMm, radarHeightMm,
    });
  };

  const onHeightChange = (ft: number, ins: number) =>
    setCalibMeasurements({ ft, in: ins }, { ft: distFt, in: distIn });
  const onDistChange = (ft: number, ins: number) =>
    setCalibMeasurements({ ft: heightFt, in: heightIn }, { ft, in: ins });
  const onRadarBehindChange = (ft: number, ins: number) =>
    setRadarPosition({ ft, in: ins }, { ft: radarHeightFt, in: radarHeightIn });
  const onRadarHeightChange = (ft: number, ins: number) =>
    setRadarPosition({ ft: radarBehindFt, in: radarBehindIn }, { ft, in: ins });

  return (
    <div style={s.root}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>HOME PLATE CALIBRATION</h2>
          <div style={s.subtitle}>{modeCopy.subtitle}</div>
        </div>
        <CalibBadge progress={progress} />
      </div>

      {/* ── Mode toggle (Hitting / Pitching) ────────────────────────────────── */}
      <div style={s.modeRow}>
        <ModeTab
          label="HITTING"
          active={calibrationMode === 'hitting'}
          calibrated={hittingCalibrated}
          onClick={() => setCalibrationMode('hitting')}
        />
        <ModeTab
          label="PITCHING"
          active={calibrationMode === 'pitching'}
          calibrated={pitchingCalibrated}
          onClick={() => setCalibrationMode('pitching')}
        />
        <div style={s.modeHint}>{modeCopy.placement}</div>
      </div>

      {/* ── Rig measurements ────────────────────────────────────────────────── */}
      <div style={s.measRow}>
        <MeasInput label="RIG HEIGHT"    ftVal={heightFt} inVal={heightIn} onChange={onHeightChange} />
        <div style={s.measDivider} />
        <MeasInput label="DIST TO PLATE" ftVal={distFt}   inVal={distIn}   onChange={onDistChange}   />
        <div style={{ flex: 1 }} />
        <div style={s.measNote}>
          Stored with calibration for reference.<br />
          Does not affect the PnP solve.
        </div>
      </div>

      {/* ── Radar position ──────────────────────────────────────────────────── */}
      <div style={s.measRow}>
        <MeasInput label="RADAR BEHIND PLATE" ftVal={radarBehindFt} inVal={radarBehindIn} onChange={onRadarBehindChange} />
        <div style={s.measDivider} />
        <MeasInput label="RADAR HEIGHT"       ftVal={radarHeightFt} inVal={radarHeightIn} onChange={onRadarHeightChange} />
        <div style={{ flex: 1 }} />
        <div style={s.measNote}>
          Saved to NUC on Calibrate.<br />
          Used for cosine correction.
        </div>
      </div>

      {/* ── Plate diagram + corner progress ─────────────────────────────────── */}
      <div style={s.guideRow}>
        <PlateDiagram n0={corners0.length} n1={corners1.length} />
        <div style={s.cornerList}>
          <div style={s.cornerListTitle}>Click corners in order (both cameras):</div>
          {CORNER_LABELS.map((lbl, i) => {
            const c0 = i < corners0.length;
            const c1 = i < corners1.length;
            const color = c0 && c1 ? '#44ff88' : c0 || c1 ? '#ffaa44' : '#d0d4dc';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 14 }}>{i + 1}</span>
                <span style={{ fontSize: 11, color, minWidth: 30 }}>{lbl}</span>
                <span style={{ fontSize: 10, color: '#2a2a3a', flex: 1 }}>{CORNER_DESCS[i]}</span>
                <span style={{ fontSize: 10, color: c0 ? '#44ff88' : '#e0e4ec', minWidth: 28 }}>
                  {c0 ? '● ' : '○ '}0
                </span>
                <span style={{ fontSize: 10, color: c1 ? '#44ff88' : '#e0e4ec', minWidth: 28 }}>
                  {c1 ? '● ' : '○ '}1
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Camera feeds (clickable) ─────────────────────────────────────────── */}
      <div style={s.camsRow}>
        <ClickableCamFeed
          label="CAMERA 0"
          jpeg={lastFrame?.cam0}
          corners={corners0}
          onAdd={(x, y) => addCorner(0, x, y)}
          fps={piHealth?.cam0Fps}
        />
        <ClickableCamFeed
          label="CAMERA 1"
          jpeg={lastFrame?.cam1}
          corners={corners1}
          onAdd={(x, y) => addCorner(1, x, y)}
          fps={piHealth?.cam1Fps}
        />
      </div>

      {/* ── Action row ──────────────────────────────────────────────────────── */}
      <div style={s.actionRow}>
        <button
          style={{
            ...s.resetBtn,
            opacity: corners0.length === 0 && corners1.length === 0 ? 0.3 : 1,
            cursor:  corners0.length === 0 && corners1.length === 0 ? 'not-allowed' : 'pointer',
          }}
          disabled={corners0.length === 0 && corners1.length === 0}
          onClick={resetCorners}
        >
          RESET CORNERS
        </button>
        <div style={{ flex: 1 }} />
        <button
          style={{
            ...s.calibBtn,
            opacity: canSubmit ? 1 : 0.3,
            cursor:  canSubmit ? 'pointer' : 'not-allowed',
          }}
          disabled={!canSubmit}
          onClick={calibrate}
          title={canSubmit ? 'Calibrate from clicked corners' : 'Place 5 corners on each camera first'}
        >
          {collecting ? 'SOLVING...' : '▶  CALIBRATE'}
        </button>
      </div>

      {/* ── Progress ─────────────────────────────────────────────────────────── */}
      {collecting && (
        <ProgressBar current={progress?.progress ?? 0} total={progress?.total ?? 1} />
      )}

      {/* ── Result ───────────────────────────────────────────────────────────── */}
      {done && progress && <ResultCard progress={progress} />}

      {/* ── Post-calib: pitching gets a 2nd step, hitting goes to selector ─── */}
      {done && calibrationMode === 'hitting' && (
        <SessionTypeSelector mode="hitting" />
      )}
      {done && calibrationMode === 'pitching' && pitchingCalibStep === 'rubber' && (
        <RubberAlignment />
      )}
      {done && calibrationMode === 'pitching' && pitchingCalibStep === 'done' && (
        <SessionTypeSelector mode="pitching" />
      )}

      {/* ── Error ────────────────────────────────────────────────────────────── */}
      {error && <div style={s.errorBox}>{progress?.message}</div>}

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <div style={s.footer}>
        Set <code style={s.code}>LENS_FOCAL_MM</code> in <code style={s.code}>nuc/config.py</code>{' '}
        to your actual lens focal length — a single planar view cannot recover it automatically.
      </div>

    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: 24,
    gap: 14,
    overflow: 'auto',
    maxWidth: 900,
    boxSizing: 'border-box',
  },

  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#332e1f',
    margin: 0,
    letterSpacing: '0.05em',
  },
  subtitle: {
    fontSize: 10,
    color: '#d0d4dc',
    marginTop: 4,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
  },

  modeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#07080f',
    border: '1px solid #111122',
    borderRadius: 6,
    padding: '10px 14px',
  },
  modeHint: {
    flex: 1,
    fontSize: 10,
    color: '#d0d4dc',
    lineHeight: 1.5,
    marginLeft: 8,
  },

  measRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    background: '#07080f',
    border: '1px solid #111122',
    borderRadius: 6,
    padding: '12px 16px',
  },
  measDivider: {
    width: 1,
    height: 32,
    background: '#1a1a2e',
    flexShrink: 0,
  },
  measNote: {
    fontSize: 10,
    color: '#e0e4ec',
    lineHeight: 1.5,
    textAlign: 'right' as const,
  },
  numInput: {
    width: 44,
    background: '#0a0a18',
    border: '1px solid #1a1a30',
    borderRadius: 4,
    color: '#332e1f',
    fontSize: 14,
    fontWeight: 700,
    padding: '4px 6px',
    fontFamily: 'inherit',
    textAlign: 'center' as const,
    outline: 'none',
  },

  guideRow: {
    display: 'flex',
    gap: 16,
    alignItems: 'flex-start',
    background: '#07080f',
    border: '1px solid #111122',
    borderRadius: 6,
    padding: '12px 16px',
  },
  cornerList: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 5,
  },
  cornerListTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: '#332e1f',
    marginBottom: 4,
    letterSpacing: '0.05em',
  },

  camsRow: {
    display: 'flex',
    gap: 12,
  },

  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  resetBtn: {
    padding: '9px 16px',
    background: 'transparent',
    color: '#c0c4cc',
    border: '1px solid #1a1a2e',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
    transition: 'opacity 0.2s',
  },
  calibBtn: {
    padding: '9px 22px',
    background: '#001a40',
    color: '#55aaff',
    border: '1px solid #1a3a70',
    borderRadius: 5,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.1em',
    fontFamily: 'inherit',
    transition: 'opacity 0.2s',
  },

  progressWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  progressTrack: {
    height: 8,
    background: '#07070f',
    border: '1px solid #1a1a2e',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #1a5a9a, #44aaff)',
    transition: 'width 0.35s ease',
    borderRadius: 4,
  },
  progressLabel: {
    fontSize: 11,
    color: '#a0a4ac',
    textAlign: 'center' as const,
    letterSpacing: '0.05em',
  },

  resultCard: {
    background: '#07091a',
    border: '1px solid #1a1a30',
    borderRadius: 6,
    padding: '14px 18px',
  },
  resultMetrics: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
  },
  divider: {
    width: 1,
    height: 36,
    background: '#1a1a30',
    margin: '0 16px',
    flexShrink: 0,
  },

  readyBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    background: '#041a08',
    border: '1px solid #1a4a20',
    borderRadius: 6,
    padding: '14px 18px',
  },
  readyArrow: {
    fontSize: 32,
    color: '#44ff88',
    lineHeight: 1,
    flexShrink: 0,
  },
  readyTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#44ff88',
    letterSpacing: '0.04em',
    marginBottom: 5,
  },
  readyBody: {
    fontSize: 11,
    color: '#3a8a50',
    lineHeight: 1.6,
  },

  errorBox: {
    fontSize: 12,
    color: '#ff4455',
    background: '#1a0010',
    border: '1px solid #441020',
    borderRadius: 5,
    padding: '9px 14px',
    lineHeight: 1.55,
  },

  footer: {
    fontSize: 11,
    color: '#d0d4dc',
    lineHeight: 1.6,
    marginTop: 4,
  },
  code: {
    fontFamily: 'monospace',
    background: '#0d0d1a',
    border: '1px solid #1a1a2e',
    borderRadius: 3,
    padding: '1px 5px',
    fontSize: 10,
    color: '#a0a4ac',
  },
};
