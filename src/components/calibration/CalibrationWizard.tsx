import React from 'react';
import { useStore } from '@/state/store';
import { usePipelineStatus, useCalibrationProgress } from '@/state/store';
import { piClient } from '@/ws/client';
import type { CalibrationProgress } from '@/state/session.slice';

// ── Grade helper ──────────────────────────────────────────────────────────────

function grade(rmsMm: number, reprojPx: number): { label: string; color: string } {
  if (rmsMm < 5  && reprojPx < 1.5) return { label: 'Excellent', color: '#44ff88' };
  if (rmsMm < 15 && reprojPx < 3.0) return { label: 'Good',      color: '#ffaa44' };
  return { label: 'Rough — move the plate larger in frame or improve lighting', color: '#ff4455' };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CalibBadge({ progress }: { progress: CalibrationProgress | null }) {
  const done       = progress?.state === 'done';
  const collecting = progress?.state === 'collecting';

  const color = done ? '#44ff88' : collecting ? '#44aaff' : '#445';
  const dot   = done ? '●' : collecting ? '◌' : '○';
  const label = done ? 'CALIBRATED' : collecting ? 'CALIBRATING…' : 'NOT CALIBRATED';

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

function CamFeed({ label, jpeg, found }: { label: string; jpeg?: string; found: boolean }) {
  return (
    <div style={s.camBox}>
      <div style={s.camHeader}>
        <span style={{ ...s.camDot, background: found ? '#44ff88' : '#ff3322',
                       boxShadow: found ? '0 0 6px #44ff88' : 'none' }} />
        <span style={s.camLabel}>{label}</span>
        <span style={{ fontSize: 10, color: found ? '#44ff88' : '#883322',
                       marginLeft: 'auto', fontWeight: 700 }}>
          {found ? 'PLATE FOUND' : 'SEARCHING'}
        </span>
      </div>
      {jpeg
        ? <img src={`data:image/jpeg;base64,${jpeg}`} style={s.camImg} alt={label} />
        : <div style={s.camPlaceholder}>Waiting for camera…</div>
      }
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.min(100, Math.round((current / Math.max(total, 1)) * 100));
  return (
    <div style={s.progressWrap}>
      <div style={s.progressTrack}>
        <div style={{ ...s.progressFill, width: `${pct}%` }} />
      </div>
      <div style={s.progressLabel}>
        {current} / {total} samples collected
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
      <div style={{ fontSize: 11, fontWeight: 700, color, marginTop: 8 }}>
        ✓ {label}
      </div>
    </div>
  );
}

function ResultMetric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 9, color: '#445', letterSpacing: '0.12em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#cde', fontVariantNumeric: 'tabular-nums' }}>
        {value}
        <span style={{ fontSize: 10, color: '#556', marginLeft: 3 }}>{unit}</span>
      </div>
    </div>
  );
}

// ── Main calibration panel ────────────────────────────────────────────────────

export function CalibrationWizard(): React.ReactElement {
  const { wsConnected } = usePipelineStatus();
  const progress  = useCalibrationProgress();
  const lastFrame = useStore((s) => s.lastFrame);

  const collecting = progress?.state === 'collecting';
  const done       = progress?.state === 'done';
  const error      = progress?.state === 'error';

  const both = lastFrame?.cornersFound[0] === true && lastFrame?.cornersFound[1] === true;

  const calibrate = () => piClient.send({ type: 'calibrate' });

  return (
    <div style={s.root}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>HOME PLATE CALIBRATION</h2>
          <div style={s.subtitle}>No board required · stereo PnP · auto-solve</div>
        </div>
        <CalibBadge progress={progress} />
      </div>

      {/* ── Live camera feeds ───────────────────────────────────────────────── */}
      <div style={s.camsRow}>
        <CamFeed
          label="CAMERA 0"
          jpeg={lastFrame?.cam0}
          found={lastFrame?.cornersFound[0] ?? false}
        />
        <CamFeed
          label="CAMERA 1"
          jpeg={lastFrame?.cam1}
          found={lastFrame?.cornersFound[1] ?? false}
        />
      </div>

      {/* ── Hint when plate not yet found ───────────────────────────────────── */}
      {!wsConnected && (
        <div style={s.hintBox}>
          Connect to the launch monitor (Capture tab) to see live camera feeds.
        </div>
      )}
      {wsConnected && !collecting && !both && (
        <div style={s.hintBox}>
          Place a regulation home plate flat and evenly lit in <strong>both</strong> camera views, then click Calibrate.
        </div>
      )}
      {wsConnected && !collecting && both && (
        <div style={{ ...s.hintBox, ...s.hintReady }}>
          Both cameras see the plate — ready to calibrate.
        </div>
      )}

      {/* ── Progress bar during collection ──────────────────────────────────── */}
      {collecting && (
        <ProgressBar
          current={progress?.progress ?? 0}
          total={progress?.total ?? 30}
        />
      )}

      {/* ── Result after success ────────────────────────────────────────────── */}
      {done && progress && <ResultCard progress={progress} />}

      {/* ── Error message ───────────────────────────────────────────────────── */}
      {error && (
        <div style={s.errorBox}>{progress?.message}</div>
      )}

      {/* ── Calibrate button ────────────────────────────────────────────────── */}
      <button
        style={{
          ...s.calibBtn,
          opacity: (!wsConnected || collecting) ? 0.35 : 1,
          cursor:  (!wsConnected || collecting) ? 'not-allowed' : 'pointer',
        }}
        disabled={!wsConnected || collecting}
        onClick={calibrate}
      >
        {collecting
          ? `CALIBRATING… ${progress?.progress ?? 0} / ${progress?.total ?? 30}`
          : done
          ? '⟳  RE-CALIBRATE'
          : '⊞  CALIBRATE HOME PLATE'}
      </button>

      {/* ── Footer hint ─────────────────────────────────────────────────────── */}
      <div style={s.footer}>
        First time on this rig? Set <code style={s.code}>LENS_FOCAL_MM</code> and{' '}
        <code style={s.code}>SENSOR_PIXEL_PITCH_UM</code> in{' '}
        <code style={s.code}>nuc/config.py</code> — a single planar view cannot recover
        focal length automatically.
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
    gap: 16,
    overflow: 'auto',
    maxWidth: 860,
    boxSizing: 'border-box',
  },

  // Header
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#aabbd0',
    margin: 0,
    letterSpacing: '0.05em',
  },
  subtitle: {
    fontSize: 10,
    color: '#445',
    marginTop: 4,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },

  // Camera feeds
  camsRow: {
    display: 'flex',
    gap: 12,
  },
  camBox: {
    flex: 1,
    background: '#060610',
    border: '1px solid #111122',
    borderRadius: 6,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  camHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '7px 10px',
    borderBottom: '1px solid #111122',
    background: '#08081a',
  },
  camDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    transition: 'background 0.3s, box-shadow 0.3s',
  },
  camLabel: {
    fontSize: 10,
    color: '#778',
    fontWeight: 700,
    letterSpacing: '0.08em',
  },
  camImg: {
    width: '100%',
    display: 'block',
    aspectRatio: '4/3',
    objectFit: 'cover',
  },
  camPlaceholder: {
    aspectRatio: '4/3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    color: '#2a2a3a',
  },

  // Hints
  hintBox: {
    fontSize: 12,
    color: '#667',
    background: '#0a0a14',
    border: '1px solid #1a1a2e',
    borderRadius: 5,
    padding: '9px 14px',
    lineHeight: 1.55,
  },
  hintReady: {
    color: '#44cc66',
    borderColor: '#143020',
    background: '#05100a',
  },

  // Progress bar
  progressWrap: {
    display: 'flex',
    flexDirection: 'column',
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
    color: '#778',
    textAlign: 'center' as const,
    letterSpacing: '0.05em',
  },

  // Result card
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

  // Error
  errorBox: {
    fontSize: 12,
    color: '#ff4455',
    background: '#1a0010',
    border: '1px solid #441020',
    borderRadius: 5,
    padding: '9px 14px',
    lineHeight: 1.55,
  },

  // Calibrate button
  calibBtn: {
    padding: '13px 28px',
    background: '#001a40',
    color: '#55aaff',
    border: '1px solid #1a3a70',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.1em',
    fontFamily: 'inherit',
    alignSelf: 'flex-start',
    transition: 'opacity 0.2s',
  },

  // Footer
  footer: {
    fontSize: 11,
    color: '#445',
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
    color: '#778',
  },
};
