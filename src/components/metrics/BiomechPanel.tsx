import React from 'react';
import type { BiomechData } from '@/types/biomechanics';

interface BiomechPanelProps {
  biomech: BiomechData;
}

export function BiomechPanel({ biomech }: BiomechPanelProps): React.ReactElement {
  const { hipShoulderSep, leadLeg, armSlot, torqueEstimateNm } = biomech;

  return (
    <div style={styles.root}>
      <div style={styles.sectionTitle}>BIOMECHANICAL ANALYSIS</div>

      <div style={styles.grid}>
        {/* Hip-Shoulder Separation */}
        <div style={styles.block}>
          <div style={styles.blockTitle}>HIP–SHOULDER SEP.</div>
          <div style={styles.bigNumber}>{hipShoulderSep.peakSeparationDeg.toFixed(1)}<span style={styles.unit}>°</span></div>
          <GaugeBar
            value={hipShoulderSep.peakSeparationDeg}
            min={0}
            max={60}
            good={[35, 55]}
            label="Peak separation"
          />
          <div style={styles.subRow}>
            <SubMetric label="AT CONTACT" value={`${hipShoulderSep.separationAtContact.toFixed(1)}°`} />
            <SubMetric label="SEQ DELAY"  value={`${hipShoulderSep.sequenceDelayFrames} fr`} />
          </div>
        </div>

        {/* Lead Leg Block */}
        <div style={styles.block}>
          <div style={styles.blockTitle}>LEAD LEG BLOCK</div>
          <div style={styles.bigNumber}>{leadLeg.kneeFlexionAtContact.toFixed(1)}<span style={styles.unit}>°</span></div>
          <GaugeBar
            value={leadLeg.stiffnessIndex}
            min={0}
            max={1}
            good={[0.6, 1.0]}
            label={`Stiffness index ${(leadLeg.stiffnessIndex * 100).toFixed(0)}%`}
          />
          <div style={styles.subRow}>
            <SubMetric label="KNEE FLEX"   value={`${leadLeg.kneeFlexionAtContact.toFixed(0)}°`} />
            <SubMetric label="PLANT FRAME" value={`#${leadLeg.landingFrame}`} />
          </div>
        </div>

        {/* Arm Slot */}
        <div style={styles.block}>
          <div style={styles.blockTitle}>ARM SLOT</div>
          <div style={styles.bigNumber}>{armSlot.releaseAngleDeg.toFixed(1)}<span style={styles.unit}>°</span></div>
          <GaugeBar
            value={armSlot.consistencyScore}
            min={0}
            max={1}
            good={[0.7, 1.0]}
            label={`Consistency ${(armSlot.consistencyScore * 100).toFixed(0)}%`}
          />
          <div style={styles.subRow}>
            <SubMetric label="RELEASE ANG"   value={`${armSlot.releaseAngleDeg.toFixed(1)}°`} />
            <SubMetric label="CONSISTENCY"   value={`${(armSlot.consistencyScore * 100).toFixed(0)}%`} />
          </div>
        </div>

        {/* Torque */}
        <div style={styles.block}>
          <div style={styles.blockTitle}>ROTATIONAL TORQUE</div>
          <div style={{ ...styles.bigNumber, color: '#ffaa44' }}>
            {torqueEstimateNm.toFixed(1)}<span style={styles.unit}> N·m</span>
          </div>
          <GaugeBar value={torqueEstimateNm} min={0} max={200} good={[80, 180]} label="Estimated torque" />
          <div style={styles.note}>
            Approx. from hip-shoulder angular momentum. Not a direct force measurement.
          </div>
        </div>
      </div>
    </div>
  );
}

function GaugeBar({
  value,
  min,
  max,
  good,
  label,
}: {
  value: number;
  min: number;
  max: number;
  good: [number, number];
  label: string;
}) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const goodLow  = (good[0] - min) / (max - min);
  const goodHigh = (good[1] - min) / (max - min);
  const inRange  = pct >= goodLow && pct <= goodHigh;

  return (
    <div style={styles.gaugeWrapper}>
      <div style={styles.gaugeTrack}>
        {/* Good range highlight */}
        <div style={{
          position: 'absolute',
          left: `${goodLow * 100}%`,
          width: `${(goodHigh - goodLow) * 100}%`,
          height: '100%',
          background: 'rgba(68,255,136,0.12)',
          borderLeft: '1px solid rgba(68,255,136,0.3)',
          borderRight: '1px solid rgba(68,255,136,0.3)',
        }} />
        {/* Fill */}
        <div style={{
          width: `${pct * 100}%`,
          height: '100%',
          background: inRange ? '#44ff88' : '#ffaa44',
          borderRadius: 2,
          transition: 'width 0.4s ease',
        }} />
      </div>
      <div style={styles.gaugeLabel}>{label}</div>
    </div>
  );
}

function SubMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.subMetric}>
      <span style={styles.subLabel}>{label}</span>
      <span style={styles.subValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 12 },
  sectionTitle: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.15em', color: '#445',
    paddingBottom: 4, borderBottom: '1px solid #1a1a2e',
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
  block: {
    background: '#0d0d18', border: '1px solid #1a1a2e', borderRadius: 8,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
  },
  blockTitle: { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#445' },
  bigNumber: { fontSize: 30, fontWeight: 700, color: '#aabbdd', lineHeight: 1, fontVariantNumeric: 'tabular-nums' },
  unit: { fontSize: 13, opacity: 0.5, marginLeft: 2 },
  gaugeWrapper: { display: 'flex', flexDirection: 'column', gap: 3 },
  gaugeTrack: { position: 'relative', height: 6, background: '#111', borderRadius: 3, overflow: 'visible' },
  gaugeLabel: { fontSize: 9, color: '#445' },
  subRow: { display: 'flex', gap: 12 },
  subMetric: { display: 'flex', flexDirection: 'column', gap: 1 },
  subLabel: { fontSize: 8, color: '#334', letterSpacing: '0.08em' },
  subValue: { fontSize: 11, color: '#778', fontVariantNumeric: 'tabular-nums' },
  note: { fontSize: 9, color: '#334', fontStyle: 'italic', lineHeight: 1.4 },
};
