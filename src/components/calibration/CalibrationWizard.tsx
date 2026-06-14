import React from 'react';

/**
 * Calibration is performed on the launch-monitor backend (the NUC), where the
 * cameras are connected — not in the browser. This panel documents the correct
 * workflow; see nuc/CALIBRATION.md for full details.
 */
export function CalibrationWizard(): React.ReactElement {
  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h2 style={styles.title}>Stereo Camera Calibration</h2>
        <div style={styles.subtitle}>Runs on the launch monitor (NUC)</div>
      </div>

      <p style={styles.lead}>
        Calibration runs on the machine the cameras are plugged into. It writes{' '}
        <code style={styles.code}>calibration.npz</code> into the{' '}
        <code style={styles.code}>nuc\</code> folder, which the pipeline loads
        automatically on start. Recalibrate whenever the cameras are moved.
      </p>

      {/* ── Method 1: home plate ─────────────────────────────────────────── */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.badgeRec}>RECOMMENDED</span>
          <span style={styles.cardTitle}>Home plate — no board</span>
        </div>
        <p style={styles.cardLead}>
          A regulation home plate is a known-size target. An AI keypoint model
          finds its five corners in both cameras and solves the stereo geometry
          from a single shared view.
        </p>
        <ol style={styles.list}>
          <li>
            Set your lens in <code style={styles.code}>nuc\config.py</code>:{' '}
            <code style={styles.code}>LENS_FOCAL_MM</code> (your 5–50&nbsp;mm
            lens's actual setting) and <code style={styles.code}>SENSOR_PIXEL_PITCH_UM</code>.
          </li>
          <li>
            In the <code style={styles.code}>nuc\</code> folder run:
            <pre style={styles.cmd}>python plate_calib.py --live</pre>
            Add <code style={styles.code}>--refine-focal</code> to estimate the
            focal length from the plate instead of measuring the lens.
          </li>
          <li>
            Place a home plate flat in <strong>both</strong> camera views — as
            large in frame and as evenly lit as possible — and hold steady while
            it averages 30 frames.
          </li>
          <li>
            Verify the result (horizontal lines should cross matching features):
            <pre style={styles.cmd}>python plate_calib.py --verify</pre>
          </li>
        </ol>
        <div style={styles.hint}>
          Aim for a self-check under ~5&nbsp;mm RMS. No PyTorch needed — a
          classical detector is the fallback; train the model with{' '}
          <code style={styles.code}>train_plate_model.py</code> for best robustness.
        </div>
      </div>

      {/* ── Method 2: ChArUco board ──────────────────────────────────────── */}
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span style={styles.badgeAlt}>ALTERNATIVE</span>
          <span style={styles.cardTitle}>ChArUco board — most accurate</span>
        </div>
        <p style={styles.cardLead}>
          Solves full intrinsics and lens distortion from many board views.
          Worth doing once to pin down the lens, then use the plate for quick
          re-checks.
        </p>
        <ol style={styles.list}>
          <li>
            Generate and print the board, then mount it flat:
            <pre style={styles.cmd}>python calibrate.py --print-board</pre>
          </li>
          <li>
            Capture ~25 poses, tilting and rotating to cover both full views:
            <pre style={styles.cmd}>python calibrate.py --live</pre>
          </li>
          <li>
            Verify the rectified alignment:
            <pre style={styles.cmd}>python calibrate.py --verify</pre>
          </li>
        </ol>
        <div style={styles.hint}>Aim for a reprojection error under 0.5&nbsp;px.</div>
      </div>

      <div style={styles.footer}>
        Full details and tuning tips: <code style={styles.code}>nuc/CALIBRATION.md</code>
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
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  cardTitle: { fontSize: 14, fontWeight: 700, color: '#aabbd0' },
  badgeRec: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
    color: '#44ff88', background: '#06200f', border: '1px solid #14401f',
    borderRadius: 4, padding: '2px 7px',
  },
  badgeAlt: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
    color: '#66aaff', background: '#001833', border: '1px solid #1a3a6e',
    borderRadius: 4, padding: '2px 7px',
  },
  cardLead: { fontSize: 12, color: '#778', lineHeight: 1.6, margin: '0 0 12px' },
  list: {
    paddingLeft: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    fontSize: 13,
    color: '#889',
    lineHeight: 1.6,
    margin: 0,
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
  cmd: {
    fontFamily: 'inherit',
    fontSize: 12,
    color: '#cfe3ff',
    background: '#07101e',
    border: '1px solid #16243e',
    borderRadius: 4,
    padding: '8px 12px',
    margin: '6px 0 0',
    overflowX: 'auto',
  },
  hint: { fontSize: 11, color: '#556', lineHeight: 1.6, marginTop: 12 },
  footer: { fontSize: 11, color: '#445', letterSpacing: '0.04em' },
};
