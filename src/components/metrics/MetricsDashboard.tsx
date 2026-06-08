import React from 'react';
import { useStore, useSwings, useActiveSwing } from '@/state/store';
import type { SwingSession } from '@/types/pipeline';
import { BiomechPanel } from './BiomechPanel';
import { EVChart } from './EVChart';
import { SprayChart } from './SprayChart';

function exportCsv(swings: SwingSession[]): void {
  const header = [
    'swing', 'timestamp', 'exit_velocity_mph', 'launch_angle_deg',
    'spray_angle_deg', 'spin_rate_rpm', 'spin_efficiency_pct',
    'spin_axis_x', 'spin_axis_y', 'spin_axis_z',
    'detect_rate_pct', 'latency_ms',
  ].join(',');

  const rows = [...swings].reverse().map((sw, i) => [
    i + 1,
    new Date(sw.timestamp).toISOString(),
    sw.ball.exitVelocity,
    sw.ball.launchAngle,
    sw.ball.sprayAngle,
    sw.ball.seam?.spinRate ?? '',
    sw.ball.seam != null ? (sw.ball.seam.spinEfficiency * 100).toFixed(1) : '',
    sw.ball.seam?.spinAxis[0].toFixed(3) ?? '',
    sw.ball.seam?.spinAxis[1].toFixed(3) ?? '',
    sw.ball.seam?.spinAxis[2].toFixed(3) ?? '',
    (sw.ball.detectRate * 100).toFixed(1),
    sw.ball.processingLatencyMs.toFixed(0),
  ].join(','));

  const csv  = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ovlm_session_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const MPH_TO_KPH = 1.60934;

function fmtEv(ev: number, unit: 'mph' | 'kph'): string {
  return unit === 'kph' ? (ev * MPH_TO_KPH).toFixed(1) : String(ev);
}

export function MetricsDashboard(): React.ReactElement {
  const swings = useSwings();
  const activeSwing = useActiveSwing();
  const setActiveSwing = useStore((s) => s.setActiveSwing);
  const aggregates = useStore((s) => s.aggregates);
  const selectedIds = useStore((s) => s.selectedSwingIds);
  const toggleSwing = useStore((s) => s.toggleSwingSelection);
  const recompute = useStore((s) => s.recomputeAggregates);
  const settings = useStore((s) => s.settings);
  const { evUnit, laOptimalMin, laOptimalMax } = settings;

  const handleToggle = (id: string) => {
    toggleSwing(id);
    recompute();
  };

  if (swings.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={{ fontSize: 36 }}>⚾</div>
        <div style={{ fontSize: 13, color: '#445', marginTop: 12 }}>No swings recorded yet.</div>
        <div style={{ fontSize: 11, color: '#334', marginTop: 4 }}>
          Switch to Capture, arm the mic trigger, and take some cuts.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {/* EV history chart — full width across the top */}
      <EVChart />

      {/* Swing list + detail — fills remaining height */}
      <div style={styles.body}>
      {/* Swing list sidebar */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>SWINGS ({swings.length})</div>
        <div style={styles.swingList}>
          {swings.map((sw, i) => (
            <div
              key={sw.id}
              style={{
                ...styles.swingRow,
                ...(sw.id === activeSwing?.id ? styles.swingRowActive : {}),
              }}
              onClick={() => setActiveSwing(sw.id)}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(sw.id)}
                onChange={() => handleToggle(sw.id)}
                onClick={(e) => e.stopPropagation()}
                style={{ margin: 0 }}
              />
              <div style={styles.swingIndex}>#{swings.length - i}</div>
              <div style={styles.swingMeta}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#cc8844', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtEv(sw.ball.exitVelocity, evUnit)} <span style={{ fontSize: 9, color: '#667' }}>{evUnit}</span>
                </div>
                <div style={{ fontSize: 9, color: '#556' }}>
                  LA: {sw.ball.launchAngle}° | {new Date(sw.timestamp).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Session aggregates */}
        {selectedIds.size > 0 && (
          <div style={styles.aggregatePanel}>
            <div style={styles.sidebarHeader}>SELECTED AVG ({aggregates.sessionCount})</div>
            <AggRow label="Exit Vel"   value={`${fmtEv(aggregates.avgExitVelocity, evUnit)} ${evUnit}`} />
            <AggRow label="Max EV"     value={`${fmtEv(aggregates.maxExitVelocity, evUnit)} ${evUnit}`} />
            <AggRow label="Launch ∠"   value={`${aggregates.avgLaunchAngle.toFixed(1)}°`} />
            <AggRow label="Spin Rate"  value={`${aggregates.avgSpinRate.toFixed(0)} rpm`} />
            <AggRow label="Hip-Sh Sep" value={`${aggregates.avgHipShoulderSep.toFixed(1)}°`} />
            <AggRow label="Torque"     value={`${aggregates.avgTorqueNm.toFixed(1)} N·m`} />
          </div>
        )}

        {/* Export */}
        <div style={styles.exportRow}>
          <button style={styles.exportBtn} onClick={() => exportCsv(swings)}>
            ↓ Export CSV
          </button>
        </div>
      </div>

      {/* Detail panel for active swing */}
      {activeSwing ? (
        <div style={styles.detail}>
          {/* Ball metrics */}
          <div style={styles.metricsGrid}>
            <MetricCard label="EXIT VELOCITY" value={fmtEv(activeSwing.ball.exitVelocity, evUnit)} unit={evUnit}
              color="#ff6644" note={evNote(activeSwing.ball.exitVelocity)}
              badge={activeSwing.ball.evSource === 'radar' ? 'RADAR' : undefined}
              badgeColor="#44aaff" />
            <MetricCard label="LAUNCH ANGLE"  value={`${activeSwing.ball.launchAngle}`}  unit="°"
              color="#44aaff" note={laNote(activeSwing.ball.launchAngle, laOptimalMin, laOptimalMax)} />
            <MetricCard label="SPRAY ANGLE"   value={`${activeSwing.ball.sprayAngle}`}   unit="°"
              color="#44ff88" note={saNote(activeSwing.ball.sprayAngle)} />
            {activeSwing.ball.seam && (
              <>
                <MetricCard label="SPIN RATE"  value={`${activeSwing.ball.seam.spinRate.toLocaleString()}`} unit="rpm"
                  color="#aa88ff" />
                <MetricCard label="SPIN AXIS"
                  value={activeSwing.ball.seam.spinAxis.map((v) => v.toFixed(2)).join(', ')}
                  unit="unit vec" color="#88aaff" />
                <MetricCard label="SPIN EFF."  value={`${(activeSwing.ball.seam.spinEfficiency * 100).toFixed(0)}`}
                  unit="%" color="#ffaa44" />
              </>
            )}
            <MetricCard label="DETECT RATE" value={`${(activeSwing.ball.detectRate * 100).toFixed(0)}`} unit="%"
              color={activeSwing.ball.detectRate >= 0.7 ? '#44ff88' : activeSwing.ball.detectRate >= 0.4 ? '#ffaa00' : '#ff4455'}
              note={activeSwing.ball.detectRate < 0.4 ? 'Low — check exposure' : undefined} />
            <MetricCard label="LATENCY" value={`${activeSwing.ball.processingLatencyMs.toFixed(0)}`} unit="ms"
              color={activeSwing.ball.processingLatencyMs > 400 ? '#ff4455' : '#44ff88'} />
          </div>

          {/* Spray chart */}
          <SprayChart />

          {/* Biomechanics */}
          {activeSwing.biomech && <BiomechPanel biomech={activeSwing.biomech} />}
        </div>
      ) : (
        <div style={styles.selectPrompt}>← Select a swing to view details</div>
      )}
      </div>  {/* end body */}
    </div>
  );
}

function MetricCard({ label, value, unit, color, note, badge, badgeColor }: {
  label: string; value: string; unit: string; color: string;
  note?: string; badge?: string; badgeColor?: string;
}) {
  return (
    <div style={styles.card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={styles.cardLabel}>{label}</div>
        {badge && (
          <div style={{
            fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
            color: badgeColor ?? '#445',
            border: `1px solid ${badgeColor ?? '#445'}`,
            borderRadius: 3, padding: '1px 4px', opacity: 0.8,
          }}>
            {badge}
          </div>
        )}
      </div>
      <div style={{ ...styles.cardValue, color }}>
        {value}<span style={styles.cardUnit}> {unit}</span>
      </div>
      {note && <div style={styles.cardNote}>{note}</div>}
    </div>
  );
}

function AggRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.aggRow}>
      <span style={styles.aggLabel}>{label}</span>
      <span style={styles.aggValue}>{value}</span>
    </div>
  );
}

function evNote(ev: number): string {
  if (ev >= 110) return 'Elite power';
  if (ev >= 100) return 'Above average';
  if (ev >= 90)  return 'Average MLB';
  return 'Below average';
}
function laNote(la: number, min = 8, max = 32): string {
  if (la >= min && la <= max) return 'Optimal range';
  if (la < 0)                 return 'Ground ball';
  if (la > 40)                return 'Pop up';
  return '';
}
function saNote(sa: number): string {
  if (Math.abs(sa) < 10)  return 'Center field';
  if (sa > 15)            return 'Pull side';
  if (sa < -15)           return 'Oppo field';
  return '';
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: 4,
  },
  sidebar: {
    width: 200, minWidth: 200, borderRight: '1px solid #1a1a2e', display: 'flex',
    flexDirection: 'column', overflow: 'hidden',
  },
  sidebarHeader: {
    padding: '10px 12px 6px', fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
    color: '#445', borderBottom: '1px solid #111',
  },
  swingList: { flex: 1, overflowY: 'auto' },
  swingRow: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer',
    borderBottom: '1px solid #0d0d18', transition: 'background 0.1s',
  },
  swingRowActive: { background: '#0d0d20' },
  swingIndex: { fontSize: 9, color: '#334', width: 20, textAlign: 'right', flexShrink: 0 },
  swingMeta: { flex: 1, minWidth: 0 },
  aggregatePanel: { borderTop: '1px solid #1a1a2e', padding: '8px 0' },
  aggRow: { display: 'flex', justifyContent: 'space-between', padding: '3px 12px' },
  aggLabel: { fontSize: 10, color: '#445' },
  aggValue: { fontSize: 10, color: '#99aacc', fontVariantNumeric: 'tabular-nums' },
  exportRow: { padding: '8px 10px', borderTop: '1px solid #111', marginTop: 'auto' },
  exportBtn: {
    width: '100%', padding: '5px 0', background: 'transparent',
    border: '1px solid #1a2a1a', borderRadius: 4, color: '#445',
    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer',
    fontFamily: 'inherit',
  },
  detail: { flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 },
  selectPrompt: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, color: '#334',
  },
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 },
  card: {
    background: '#0d0d18', border: '1px solid #1a1a2e', borderRadius: 8,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4,
  },
  cardLabel: { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#445' },
  cardValue: { fontSize: 26, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' },
  cardUnit: { fontSize: 11, opacity: 0.6 },
  cardNote: { fontSize: 9, color: '#556', marginTop: 2 },
};
