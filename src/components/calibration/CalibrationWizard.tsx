import React from 'react';
import { usePipelineStatus, useCalibrationProgress } from '@/state/store';
import { piClient } from '@/ws/client';

function grade(rmsMm: number, reprojPx: number): { label: string; color: string } {
  if (rmsMm < 5 && reprojPx < 1.5)  return { label: 'Excellent', color: '#44ff88' };
  if (rmsMm < 15 && reprojPx < 3)   return { label: 'Good',      color: '#ffaa00' };
  return { label: 'Rough — move the plate larger in frame / improve lighting', color: '#ff4455' };
}

export function CalibrationWizard(): React.ReactElement {
  const { wsConnected } = usePipelineStatus();
  const progress = useCalibrationProgress();
  const collecting = progress?.state === 'collecting';

  const calibrate = () => piClient.send({ type: 'calibrate' });

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h2 style={styles.title}>Home Plate Calibration</h2>
        <div style={styles.subtitle}>Runs on the launch monitor (NUC)</div>
      </div>

      <p style={styles.lead}>
        A regulation home plate is a known-size target. Place one flat in{' '}
        <strong>both</strong> camera views, as large in frame and as evenly lit
        as possible, then click Calibrate — it averages 30 detections and
        solves the stereo geometry automatically, no board or manual capture
        needed.
      </p>

      <div style={styles.card}>
        <div style={styles.cardTitle}>HOME PLATE CALIBRATION</div>

        <button
          style={{ ...styles.btnPrimary, opacity: !wsConnected || collecting ? 0.4 : 1 }}
          disabled={!wsConnected || collecting}
          onClick={calibrate}
        >
          {collecting ? 'CALIBRATING…' : '⊞ CALIBRATE HOME PLATE'}
        </button>

        {!wsConnected && (
          <div style={styles.hint}>Connect to the monitor (Capture tab) before calibrating.</div>
        )}

        {progress?.state === 'collecting' && (
          <div style={styles.progressWrap}>
            <div style={styles.progressBarBg}>
              <div style={{
                ...styles.progressBarFill,
                width: `${100 * (progress.progress ?? 0) / Math.max(progress.total ?? 1, 1)}%`,
              }} />
            </div>
            <div style={styles.progressText}>
              {progress.progress ?? 0} / {progress.total ?? 30} samples — hold the plate steady
            </div>
          </div>
        )}

        {progress?.state === 'done' && progress.rmsMm != null && progress.reprojPx != null && (
          <div style={styles.resultRow}>
            <Metric label="BASELINE" value={progress.baselineMm?.toFixed(1) ?? '—'} unit="mm" />
            <Metric label="REPROJ"   value={progress.reprojPx.toFixed(2)} unit="px" />
            <Metric label="PLATE RMS" value={progress.rmsMm.toFixed(1)} unit="mm" />
            <div style={{ color: grade(progress.rmsMm, progress.reprojPx).color, fontSize: 11, fontWeight: 700 }}>
              {grade(progress.rmsMm, progress.reprojPx).label}
            </div>
          </div>
        )}

        {progress?.state === 'error' && (
          <div style={styles.errorMsg}>{progress.message}</div>
        )}
      </div>

      <div style={styles.footer}>
        First time on this rig? Set your lens in{' '}
        <code style={styles.code}>nuc/config.py</code> (<code style={styles.code}>LENS_FOCAL_MM</code>,{' '}
        <code style={styles.code}>SENSOR_PIXEL_PITCH_UM</code>) — a single planar view can't recover
        focal length on its own. Need full lens-distortion correction instead? Use the ChArUco
        board method from the NUC console: <code style={styles.code}>python calibrate.py --live</code>.
        Full details: <code style={styles.code}>nuc/CALIBRATION.md</code>.
      </div>
    </div>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 9, color: '#445', letterSpacing: '0.1em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#cfe3ff', fontVariantNumeric: 'tabular-nums' }}>
        {value}<span style={{ fontSize: 10, color: '#556', marginLeft: 2 }}>{unit}</span>
      </div>
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
    maxWidth: 680,
  },
  header: { marginBottom: 0 },
  title: { fontSize: 18, fontWeight: 700, color: '#aabbd0', margin: 0 },
  subtitle: { fontSize: 11, color: '#445', marginTop: 4, letterSpacing: '0.1em' },
  lead: { fontSize: 13, color: '#889', lineHeight: 1.6, margin: 0 },
  card: {
    background: '#0d0d18',
    border: '1px solid #1a1a30',
    borderRadius: 8,
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  cardTitle: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.15em', color: '#445',
  },
  btnPrimary: {
    padding: '10px 20px',
    background: '#002244',
    color: '#66aaff',
    border: '1px solid #1a3a6e',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
    alignSelf: 'flex-start',
  },
  hint: { fontSize: 11, color: '#556', lineHeight: 1.6 },
  progressWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  progressBarBg: {
    height: 6, background: '#07070f', border: '1px solid #1a1a2e', borderRadius: 3, overflow: 'hidden',
  },
  progressBarFill: { height: '100%', background: '#44aaff', transition: 'width 0.2s' },
  progressText: { fontSize: 11, color: '#778' },
  resultRow: { display: 'flex', gap: 20, alignItems: 'center' },
  errorMsg: {
    fontSize: 11, color: '#ff4455', background: '#1a0010', border: '1px solid #441020',
    borderRadius: 4, padding: '6px 10px', lineHeight: 1.5,
  },
  code: {
    fontFamily: 'inherit',
    fontSize: 11,
    color: '#9cc4ff',
    background: '#0a1424',
    border: '1px solid #16243e',
    borderRadius: 3,
    padding: '1px 5px',
  },
  footer: { fontSize: 11, color: '#556', letterSpacing: '0.02em', lineHeight: 1.6 },
};
