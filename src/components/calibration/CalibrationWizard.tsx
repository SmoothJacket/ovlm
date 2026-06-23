import React from 'react';
import { useStore } from '@/state/store';
import { piClient } from '@/ws/client';

const FT_TO_MM = 304.8;
const IN_TO_MM = 25.4;

function toMm(ft: number, inches: number): number {
  return ft * FT_TO_MM + inches * IN_TO_MM;
}

function grade(rmsMm: number, reprojPx: number): { label: string; color: string } {
  if (rmsMm < 5 && reprojPx < 1.5)  return { label: 'Excellent', color: '#44ff88' };
  if (rmsMm < 15 && reprojPx < 3)   return { label: 'Good',      color: '#ffaa00' };
  return { label: 'Rough — move the plate larger in frame / improve lighting', color: '#ff4455' };
}

// ── Step components ───────────────────────────────────────────────────────────

function StepSetup(): React.ReactElement {
  const heightFt = useStore((s) => s.heightFt);
  const heightIn = useStore((s) => s.heightIn);
  const distFt   = useStore((s) => s.distFt);
  const distIn   = useStore((s) => s.distIn);
  const setCalibMeasurements = useStore((s) => s.setCalibMeasurements);
  const setWizardStep        = useStore((s) => s.setWizardStep);

  function start() {
    const heightMm   = toMm(heightFt, heightIn);
    const distanceMm = toMm(distFt, distIn);
    piClient.send({ type: 'calib_start', heightMm, distanceMm });
    setWizardStep(1);
  }

  return (
    <div style={s.card}>
      <div style={s.stepLabel}>STEP 1 OF 3 — RIG MEASUREMENTS</div>
      <h3 style={s.cardTitle}>Enter camera position</h3>
      <p style={s.body}>
        Enter where the camera rig is mounted. The plate detector uses these measurements
        to set the scale for the stereo solve — no ChArUco board needed.
      </p>

      <div style={s.fieldGroup}>
        <label style={s.label}>Camera height above ground</label>
        <div style={s.inputRow}>
          <input style={s.input} type="number" min={0} max={20} step={1}
            value={heightFt}
            onChange={(e) => setCalibMeasurements(
              { ft: Number(e.target.value), in: heightIn },
              { ft: distFt, in: distIn }
            )} />
          <span style={s.unit}>ft</span>
          <input style={s.input} type="number" min={0} max={11} step={1}
            value={heightIn}
            onChange={(e) => setCalibMeasurements(
              { ft: heightFt, in: Number(e.target.value) },
              { ft: distFt, in: distIn }
            )} />
          <span style={s.unit}>in</span>
        </div>
      </div>

      <div style={s.fieldGroup}>
        <label style={s.label}>Distance behind home plate</label>
        <div style={s.inputRow}>
          <input style={s.input} type="number" min={0} max={60} step={1}
            value={distFt}
            onChange={(e) => setCalibMeasurements(
              { ft: heightFt, in: heightIn },
              { ft: Number(e.target.value), in: distIn }
            )} />
          <span style={s.unit}>ft</span>
          <input style={s.input} type="number" min={0} max={11} step={1}
            value={distIn}
            onChange={(e) => setCalibMeasurements(
              { ft: heightFt, in: heightIn },
              { ft: distFt, in: Number(e.target.value) }
            )} />
          <span style={s.unit}>in</span>
        </div>
      </div>

      <div style={s.hint}>
        Typical setup: 5 ft 0 in height · 8 ft 0 in behind plate
      </div>

      <button style={s.btn} onClick={start}>
        Start Calibration →
      </button>
    </div>
  );
}

function StepAlign(): React.ReactElement {
  const lastFrame  = useStore((s) => s.lastFrame);
  const setWizardStep = useStore((s) => s.setWizardStep);

  const bothFound = lastFrame?.cornersFound[0] === true && lastFrame?.cornersFound[1] === true;

  function capture() {
    piClient.send({ type: 'calib_capture' });
    setWizardStep(2);
  }

  function cancel() {
    piClient.send({ type: 'calib_stop' });
    setWizardStep(0);
  }

  return (
    <div style={s.card}>
      <div style={s.stepLabel}>STEP 2 OF 3 — ALIGN CAMERAS</div>
      <h3 style={s.cardTitle}>Point both cameras at home plate</h3>
      <p style={s.body}>
        Place a regulation home plate flat in view of both cameras. Tilt/pan the rig until
        green corner markers appear on both feeds, then click Capture.
      </p>

      <div style={s.previewRow}>
        <div style={s.previewBox}>
          <div style={s.previewLabel}>
            <span style={lastFrame?.cornersFound[0] ? s.dotGreen : s.dotRed} />
            Camera 0
          </div>
          {lastFrame
            ? <img src={`data:image/jpeg;base64,${lastFrame.cam0}`} style={s.preview} alt="cam0" />
            : <div style={s.previewPlaceholder}>Waiting for feed…</div>
          }
        </div>
        <div style={s.previewBox}>
          <div style={s.previewLabel}>
            <span style={lastFrame?.cornersFound[1] ? s.dotGreen : s.dotRed} />
            Camera 1
          </div>
          {lastFrame
            ? <img src={`data:image/jpeg;base64,${lastFrame.cam1}`} style={s.preview} alt="cam1" />
            : <div style={s.previewPlaceholder}>Waiting for feed…</div>
          }
        </div>
      </div>

      {!bothFound && (
        <div style={s.hintWarn}>
          {lastFrame
            ? 'Adjust camera aim until both feeds show green corner markers'
            : 'Connecting to cameras…'}
        </div>
      )}
      {bothFound && (
        <div style={s.hintOk}>Both cameras see the plate — ready to capture</div>
      )}

      <div style={s.btnRow}>
        <button style={s.btnSecondary} onClick={cancel}>Cancel</button>
        <button style={{ ...s.btn, ...(bothFound ? {} : s.btnDisabled) }}
          onClick={capture} disabled={!bothFound}>
          Capture Frame →
        </button>
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

function StepProcessing(): React.ReactElement {
  return (
    <div style={s.card}>
      <div style={s.stepLabel}>STEP 3 OF 3 — SOLVING</div>
      <h3 style={s.cardTitle}>Averaging frames &amp; solving stereo geometry…</h3>
      <div style={s.spinnerWrap}>
        <div style={s.spinner} />
      </div>
      <p style={s.body}>
        Collecting 30 detection samples, then running PnP stereo solve against
        the plate's known 3-D geometry. This takes ~5 seconds.
      </p>
    </div>
  );
}

function StepResult(): React.ReactElement {
  const result     = useStore((s) => s.lastCalibResult);
  const resetWizard = useStore((s) => s.resetWizard);

  function done() {
    piClient.send({ type: 'calib_stop' });
    resetWizard();
  }

  function retry() {
    piClient.send({ type: 'calib_stop' });
    resetWizard();
  }

  if (!result) return <div style={s.card}><p style={s.body}>No result yet.</p></div>;

  return (
    <div style={s.card}>
      {result.ok ? (
        <>
          <div style={s.resultOk}>
            <span style={s.checkmark}>✓</span>
            <span>Calibration saved</span>
          </div>
          <div style={s.metricsRow}>
            <Metric label="REPROJ ERROR" value={result.reprojPx.toFixed(1)} unit="px" />
            <Metric label="BASELINE"     value={result.baselineMm.toFixed(0)} unit="mm" />
            <Metric label="PLATE RMS"    value={result.residualMm.toFixed(1)} unit="mm" />
          </div>
          <div style={{ color: grade(result.residualMm, result.reprojPx).color, fontSize: 11, fontWeight: 700 }}>
            {grade(result.residualMm, result.reprojPx).label}
          </div>
          <div style={s.hint}>{result.message}</div>
        </>
      ) : (
        <>
          <div style={s.resultErr}>
            <span style={s.xmark}>✗</span>
            <span>Calibration failed</span>
          </div>
          <p style={s.body}>{result.message}</p>
        </>
      )}

      <div style={s.btnRow}>
        <button style={s.btnSecondary} onClick={retry}>Re-calibrate</button>
        {result.ok && <button style={s.btn} onClick={done}>Done</button>}
      </div>
    </div>
  );
}

// ── Wizard shell ──────────────────────────────────────────────────────────────

export function CalibrationWizard(): React.ReactElement {
  const step = useStore((s) => s.wizardStep);

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h2 style={s.title}>Stereo Camera Calibration</h2>
        <div style={s.subtitle}>Trackman-style guided plate calibration · no board required</div>
      </div>

      <div style={s.steps}>
        {(['Setup', 'Align', 'Solving', 'Result'] as const).map((label, i) => (
          <div key={label} style={{ ...s.stepPip, ...(i === step ? s.stepPipActive : {}) }}>
            <div style={{ ...s.pipDot, ...(i === step ? s.pipDotActive : i < step ? s.pipDotDone : {}) }}>
              {i < step ? '✓' : i + 1}
            </div>
            <div style={s.pipLabel}>{label}</div>
          </div>
        ))}
      </div>

      {step === 0 && <StepSetup />}
      {step === 1 && <StepAlign />}
      {step === 2 && <StepProcessing />}
      {step === 3 && <StepResult />}
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
    gap: 20,
    overflow: 'auto',
    maxWidth: 780,
  },
  header: { marginBottom: 0 },
  title: { fontSize: 18, fontWeight: 700, color: '#aabbd0', margin: 0 },
  subtitle: { fontSize: 11, color: '#445', marginTop: 4, letterSpacing: '0.1em', textTransform: 'uppercase' },

  // Progress pip row
  steps: {
    display: 'flex',
    gap: 0,
    alignItems: 'center',
    marginBottom: 4,
  },
  stepPip: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    opacity: 0.4,
  },
  stepPipActive: { opacity: 1 },
  pipDot: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: '2px solid #2a3a50',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    color: '#556',
    flexShrink: 0,
  },
  pipDotActive: { border: '2px solid #44aaff', color: '#44aaff' },
  pipDotDone:   { border: '2px solid #44ff88', color: '#44ff88', background: '#06200f' },
  pipLabel: { fontSize: 11, color: '#667', letterSpacing: '0.07em', textTransform: 'uppercase' },

  // Card
  card: {
    background: '#0d0d18',
    border: '1px solid #1a1a30',
    borderRadius: 8,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  stepLabel: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: '#44aaff',
    textTransform: 'uppercase',
  },
  cardTitle: { fontSize: 15, fontWeight: 700, color: '#aabbd0', margin: 0 },
  body: { fontSize: 13, color: '#778', lineHeight: 1.65, margin: 0 },

  // Measurement inputs
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 12, color: '#88a', letterSpacing: '0.05em' },
  inputRow: { display: 'flex', alignItems: 'center', gap: 8 },
  input: {
    width: 64,
    background: '#07091a',
    border: '1px solid #1a2a3e',
    borderRadius: 5,
    color: '#cde',
    fontSize: 16,
    fontWeight: 700,
    padding: '6px 10px',
    textAlign: 'center' as const,
    outline: 'none',
  },
  unit: { fontSize: 12, color: '#556', marginRight: 8 },
  hint: { fontSize: 11, color: '#445', lineHeight: 1.5 },
  hintWarn: {
    fontSize: 12,
    color: '#aa7733',
    background: '#1a1000',
    border: '1px solid #2a1800',
    borderRadius: 5,
    padding: '8px 12px',
  },
  hintOk: {
    fontSize: 12,
    color: '#44ff88',
    background: '#061206',
    border: '1px solid #143014',
    borderRadius: 5,
    padding: '8px 12px',
  },

  // Camera previews
  previewRow: { display: 'flex', gap: 12 },
  previewBox: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: '#060610',
    border: '1px solid #111122',
    borderRadius: 6,
    padding: 10,
  },
  previewLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: '#778',
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
  },
  preview: { width: '100%', borderRadius: 4, display: 'block' },
  previewPlaceholder: {
    width: '100%',
    aspectRatio: '4/3',
    background: '#0a0a18',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    color: '#333',
  },
  dotGreen: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#44ff88',
    boxShadow: '0 0 6px #44ff88',
    flexShrink: 0,
  },
  dotRed: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#ff4422',
    flexShrink: 0,
  },

  // Buttons
  btnRow: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
  btn: {
    background: '#0f2a4a',
    border: '1px solid #1a4070',
    borderRadius: 6,
    color: '#7ac0ff',
    fontSize: 13,
    fontWeight: 600,
    padding: '9px 20px',
    cursor: 'pointer',
  },
  btnSecondary: {
    background: 'transparent',
    border: '1px solid #1a1a30',
    borderRadius: 6,
    color: '#556',
    fontSize: 13,
    padding: '9px 16px',
    cursor: 'pointer',
  },
  btnDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },

  // Spinner
  spinnerWrap: { display: 'flex', justifyContent: 'center', padding: '12px 0' },
  spinner: {
    width: 36,
    height: 36,
    border: '3px solid #1a2a3e',
    borderTop: '3px solid #44aaff',
    borderRadius: '50%',
    animation: 'spin 0.9s linear infinite',
  },

  // Result
  resultOk: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 16,
    fontWeight: 700,
    color: '#44ff88',
  },
  resultErr: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 16,
    fontWeight: 700,
    color: '#ff5533',
  },
  checkmark: { fontSize: 22, lineHeight: 1 },
  xmark:     { fontSize: 22, lineHeight: 1 },
  metricsRow: {
    display: 'flex',
    gap: 16,
    background: '#07091a',
    border: '1px solid #111a2a',
    borderRadius: 8,
    padding: 16,
  },
};
