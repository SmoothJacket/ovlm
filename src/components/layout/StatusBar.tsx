import React from 'react';
import { usePipelineStatus, useWsHost, useStore } from '@/state/store';

export function StatusBar(): React.ReactElement {
  const status   = usePipelineStatus();
  const host     = useWsHost();
  const health   = useStore((s) => s.piHealth);

  const stateColor: Record<string, string> = {
    idle:       '#445',
    calibrating:'#aa88ff',
    armed:      '#ffaa00',
    capturing:  '#ff4455',
    processing: '#44aaff',
    error:      '#ff2244',
  };

  const latencyColor =
    status.latencyMs > 400 ? '#ff4455' :
    status.latencyMs > 250 ? '#ffaa00' : '#44ff88';

  return (
    <div style={styles.bar}>
      {/* Pipeline state pill */}
      <div style={{ ...styles.pill, background: stateColor[status.state] ?? '#445' }}>
        {status.state.toUpperCase()}
      </div>

      {/* WS connection */}
      <div style={styles.metric}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: status.wsConnected ? '#44ff88' : '#ff4455',
          boxShadow: status.wsConnected ? '0 0 5px #44ff88' : 'none',
          flexShrink: 0,
        }} />
        <span style={{ ...styles.metricValue, color: status.wsConnected ? '#44ff88' : '#554' }}>
          {status.wsConnected ? 'MONITOR LIVE' : 'MONITOR OFFLINE'}
        </span>
      </div>

      {/* Host */}
      <div style={{ ...styles.metricLabel, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {host}
      </div>

      {/* Latency */}
      {status.latencyMs > 0 && (
        <div style={styles.metric}>
          <span style={styles.metricLabel}>LATENCY</span>
          <span style={{ ...styles.metricValue, color: latencyColor }}>
            {status.latencyMs.toFixed(0)} ms
          </span>
        </div>
      )}

      {/* Pi vitals */}
      {health && (
        <div style={styles.vitals}>
          <PiVital
            label="CPU"
            value={health.cpuTempC >= 0 ? `${health.cpuTempC.toFixed(0)}°C` : '—'}
            warn={health.cpuTempC > 75}
            crit={health.cpuTempC > 85}
          />
          <PiVital
            label="MEM"
            value={`${Math.round(health.memUsedMb)}/${Math.round(health.memTotalMb)} MB`}
            warn={health.memUsedMb / health.memTotalMb > 0.80}
            crit={health.memUsedMb / health.memTotalMb > 0.93}
          />
          <PiVital
            label="LOAD"
            value={health.loadAvg1m.toFixed(2)}
            warn={health.loadAvg1m > 3}
            crit={health.loadAvg1m > 7}
          />
        </div>
      )}

      {/* Audio armed indicator */}
      <div style={{ marginLeft: health ? 0 : 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingRight: 12 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: status.audioArmed ? '#ff4455' : '#223',
          boxShadow: status.audioArmed ? '0 0 6px #ff4455' : 'none',
          transition: 'all 0.2s',
        }} />
        <span style={{ fontSize: 10, color: '#667', letterSpacing: '0.1em' }}>
          {status.audioArmed ? 'ARMED' : 'AUDIO OFF'}
        </span>
      </div>

      {status.errorMessage && (
        <div style={styles.error}>{status.errorMessage}</div>
      )}
    </div>
  );
}

function PiVital({ label, value, warn, crit }: {
  label: string; value: string; warn: boolean; crit: boolean;
}) {
  const color = crit ? '#ff4455' : warn ? '#ffaa00' : '#445';
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
      <span style={{ fontSize: 8, color: '#334', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color }}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: 36,
    background: '#0d0d14',
    borderBottom: '1px solid #1a1a2e',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    paddingLeft: 12,
    fontSize: 11,
  },
  pill: {
    padding: '2px 8px',
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: '#fff',
  },
  metric: {
    display: 'flex',
    gap: 5,
    alignItems: 'center',
  },
  metricLabel: {
    fontSize: 9,
    color: '#445',
    letterSpacing: '0.1em',
    fontWeight: 600,
  },
  metricValue: {
    fontSize: 12,
    color: '#99aabb',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
  },
  vitals: {
    display: 'flex',
    gap: 14,
    alignItems: 'center',
    padding: '0 4px',
    borderLeft: '1px solid #1a1a2e',
    borderRight: '1px solid #1a1a2e',
    marginLeft: 'auto',
  },
  error: {
    fontSize: 10,
    color: '#ff4455',
    marginLeft: 12,
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};
