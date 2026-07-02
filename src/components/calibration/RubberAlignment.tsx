import React from 'react';
import { useStore } from '@/state/store';

/**
 * Step 2 of pitching calibration — physical camera alignment with the rubber.
 *
 * The plate is already calibrated (Step 1 produced the stereo PnP solution).
 * For pitching sessions, the cameras need to also see the pitcher's rubber
 * in frame. This panel shows both live feeds with a horizontal dashed line
 * at a fixed image-relative position; the operator physically tilts the
 * cameras so the front edge of the rubber lies on that line. No backend
 * geometry change — it's a visual aid to make framing consistent across
 * sessions so the pitcher's release point stays in the captured volume.
 */
export function RubberAlignment(): React.ReactElement {
  const lastFrame = useStore((s) => s.lastFrame);
  const piHealth  = useStore((s) => s.piHealth);
  const setPanel  = useStore((s) => s.setPanel);
  const setPitchingCalibStep = useStore((s) => s.setPitchingCalibStep);

  const onAligned = () => {
    setPitchingCalibStep('done');
    // Caller (CalibrationWizard) will now render the SessionTypeSelector
  };

  const onSkip = () => setPanel('capture');

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <span style={s.eyebrow}>STEP 2 / 2 · PITCHING</span>
          <div style={s.title}>Align the pitcher's rubber</div>
          <div style={s.subtitle}>
            Tilt and rotate both cameras until the FRONT edge of the rubber
            sits on the dashed line below. Then click <strong>RUBBER ALIGNED</strong>.
          </div>
        </div>
      </div>

      <div style={s.camsRow}>
        <RubberCamFeed label="CAMERA 0" jpeg={lastFrame?.cam0} fps={piHealth?.cam0Fps} />
        <RubberCamFeed label="CAMERA 1" jpeg={lastFrame?.cam1} fps={piHealth?.cam1Fps} />
      </div>

      <div style={s.actionRow}>
        <button style={s.skipBtn} onClick={onSkip}>SKIP — already framed</button>
        <div style={{ flex: 1 }} />
        <button style={s.doneBtn} onClick={onAligned}>✓ RUBBER ALIGNED</button>
      </div>

      <div style={s.note}>
        The rubber is 60 ft 6 in from the front edge of home plate. If the
        dashed line is way off the actual rubber, your camera is angled too
        high or too low — adjust the tilt until they meet, then confirm.
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RubberCamFeed({ label, jpeg, fps }: {
  label: string;
  jpeg?: string;
  fps?: number;
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, color: '#a0a4ac', fontWeight: 700, letterSpacing: '0.08em' }}>
          {label}
        </span>
        {fps !== undefined && fps > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700,
            color: fps >= 200 ? '#44ff88' : fps >= 100 ? '#ffaa44' : '#ff4455',
          }}>
            {fps} fps
          </span>
        )}
      </div>
      <div style={{
        position: 'relative',
        background: '#060610',
        borderRadius: 5,
        overflow: 'hidden',
        border: '1px solid #1a3a40',
        aspectRatio: '4/3',
        userSelect: 'none',
      }}>
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
        {/* Dashed rubber-alignment line + label, drawn over the feed */}
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                   pointerEvents: 'none' }}
          viewBox="0 0 640 480"
        >
          {/* Horizontal dashed line at 55% down — typical rubber Y when camera
              is framed on the contact zone with the mound in the upper half. */}
          <line
            x1={40} y1={264} x2={600} y2={264}
            stroke="#00eaff" strokeWidth={2}
            strokeDasharray="10 6"
            opacity={0.85}
          />
          {/* End ticks */}
          <line x1={40}  y1={252} x2={40}  y2={276} stroke="#00eaff" strokeWidth={2} opacity={0.85} />
          <line x1={600} y1={252} x2={600} y2={276} stroke="#00eaff" strokeWidth={2} opacity={0.85} />

          {/* Centre-of-rubber crosshair — operator should line the centre of
              the pitching rubber up with this mark. Two intersecting lines
              with a gap in the middle keep the rubber itself visible, plus a
              small filled dot at the exact intersection for sub-pixel aim. */}
          {/* Horizontal arms (left + right) with gap around centre */}
          <line x1={290} y1={264} x2={313} y2={264} stroke="#ffee44" strokeWidth={2.5} opacity={0.95} />
          <line x1={327} y1={264} x2={350} y2={264} stroke="#ffee44" strokeWidth={2.5} opacity={0.95} />
          {/* Vertical arms (top + bottom) with gap around centre */}
          <line x1={320} y1={234} x2={320} y2={257} stroke="#ffee44" strokeWidth={2.5} opacity={0.95} />
          <line x1={320} y1={271} x2={320} y2={294} stroke="#ffee44" strokeWidth={2.5} opacity={0.95} />
          {/* Outer aim ring */}
          <circle cx={320} cy={264} r={12} fill="none"
                  stroke="#ffee44" strokeWidth={1.5} opacity={0.7} />
          {/* Exact centre dot */}
          <circle cx={320} cy={264} r={2} fill="#ffee44" opacity={1} />

          <text x={320} y={222} textAnchor="middle"
                fontSize={12} fill="#ffee44" fontWeight={700} opacity={0.95}>
            CENTRE OF RUBBER
          </text>
          <text x={320} y={314} textAnchor="middle"
                fontSize={10} fill="#88ccdd" opacity={0.8}>
            60 ft 6 in from home plate
          </text>
        </svg>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    background: '#07091a',
    border: '1px solid #1a3a40',
    borderRadius: 6,
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  eyebrow: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color: '#44ff88',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#332e1f',
    letterSpacing: '0.04em',
    marginTop: 2,
  },
  subtitle: {
    fontSize: 11,
    color: '#c0c4cc',
    marginTop: 6,
    lineHeight: 1.55,
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
  skipBtn: {
    padding: '9px 16px',
    background: 'transparent',
    color: '#c0c4cc',
    border: '1px solid #1a1a2e',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  doneBtn: {
    padding: '9px 22px',
    background: '#001a40',
    color: '#55aaff',
    border: '1px solid #1a3a70',
    borderRadius: 5,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.1em',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  note: {
    fontSize: 11,
    color: '#d0d4dc',
    lineHeight: 1.6,
  },
};
