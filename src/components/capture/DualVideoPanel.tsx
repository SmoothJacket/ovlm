import React, { useState, useCallback } from 'react';
import { useStore, usePipelineStatus, useWsHost } from '@/state/store';
import { piClient } from '@/ws/client';
import type { BallMeasurement } from '@/types/tracking';
import { sessionLabel } from '../session/SessionTypeSelector';
import { StrikeZone, buildZonePoints } from '../metrics/StrikeZone';

export function DualVideoPanel(): React.ReactElement {
  const status    = usePipelineStatus();
  const wsHost    = useWsHost();
  const setWsHost = useStore((s) => s.setWsHost);
  const swings    = useStore((s) => s.swings);

  const radarStatus   = useStore((s) => s.radarStatus);
  const activeSession = useStore((s) => s.activeSession);
  const endSession    = useStore((s) => s.endSession);
  const setPanel      = useStore((s) => s.setPanel);
  const [hostDraft, setHostDraft] = useState(wsHost);

  const lastBall: BallMeasurement | null = swings[0]?.ball ?? null;

  const applyHost = useCallback(() => {
    const url = hostDraft.trim();
    if (!url) return;
    setWsHost(url);
    piClient.disconnect();
    // App's useEffect re-fires on wsHost change and reconnects
  }, [hostDraft, setWsHost]);

  const arm     = () => piClient.send({ type: 'arm' });
  const disarm  = () => piClient.send({ type: 'disarm' });
  const reset   = () => piClient.send({ type: 'reset' });
  const trigger = () => piClient.send({ type: 'trigger' });

  const connected = status.wsConnected;
  const armed     = status.state === 'armed' || status.state === 'capturing'
                 || status.state === 'processing';

  return (
    <div style={styles.root}>
      {/* ── Active session header ───────────────────────────────── */}
      {activeSession ? (
        <div style={styles.sessionBar}>
          <div style={styles.sessionLeft}>
            <span style={styles.sessionMode}>
              {activeSession.mode === 'hitting' ? 'HITTING' : 'PITCHING'}
            </span>
            <span style={styles.sessionSep}>·</span>
            <span style={styles.sessionType}>{sessionLabel(activeSession.type)}</span>
          </div>
          <button style={styles.sessionEnd} onClick={endSession}>END SESSION</button>
        </div>
      ) : (
        <button style={styles.noSessionBar} onClick={() => setPanel('calibration')}>
          ▶ Pick a session — open the Calibrate tab and choose a mode
        </button>
      )}

      {/* ── Connection card ────────────────────────────────────── */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>MONITOR CONNECTION</div>

        <div style={styles.hostRow}>
          <input
            style={styles.hostInput}
            value={hostDraft}
            onChange={(e) => setHostDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyHost()}
            placeholder="ws://localhost:8765"
            spellCheck={false}
          />
          <button style={styles.btnSecondary} onClick={applyHost}>
            CONNECT
          </button>
        </div>

        {/* WS status */}
        <div style={styles.wsStatus}>
          <div style={{
            ...styles.dot,
            background: connected ? '#44ff88' : '#ff4455',
            boxShadow: connected ? '0 0 6px #44ff88' : '0 0 6px #ff4455',
          }} />
          <span style={{ color: connected ? '#44ff88' : '#ff4455', fontSize: 11, letterSpacing: '0.08em' }}>
            {connected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
          <span style={{ fontSize: 10, color: '#d0d4dc', marginLeft: 4 }}>{wsHost}</span>
        </div>

        {status.errorMessage && (
          <div style={styles.errorMsg}>{status.errorMessage}</div>
        )}
      </div>

      {/* ── Trigger controls ────────────────────────────────────── */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>CAPTURE CONTROLS</div>
        <div style={styles.triggerRow}>
          <button
            style={{ ...styles.btnPrimary, opacity: !connected || armed ? 0.4 : 1 }}
            disabled={!connected || armed}
            onClick={arm}
          >
            🎙 ARM
          </button>
          <button
            style={{ ...styles.btnDanger, opacity: !connected || !armed ? 0.4 : 1 }}
            disabled={!connected || !armed}
            onClick={disarm}
          >
            ⬛ DISARM
          </button>
          <button
            style={{
              ...styles.btnTrigger,
              opacity: !connected || !armed ? 0.4 : 1,
            }}
            disabled={!connected || !armed}
            onClick={trigger}
            title="Manually capture the swing right now (use when no mic/radar trigger is wired up)"
          >
            ⚡ TRIGGER NOW
          </button>
          <button
            style={{ ...styles.btnSecondary, opacity: !connected ? 0.4 : 1 }}
            disabled={!connected}
            onClick={reset}
          >
            ↺ RESET
          </button>
        </div>

        <div style={styles.armedIndicator}>
          <div style={{
            ...styles.dot,
            background: armed ? '#ff4455' : '#e8ecf4',
            boxShadow: armed ? '0 0 8px #ff4455' : 'none',
            width: 10, height: 10,
            transition: 'all 0.2s',
          }} />
          <span style={{ fontSize: 11, color: armed ? '#ff4455' : '#d0d4dc', letterSpacing: '0.12em' }}>
            {armed ? 'ARMED — WAITING FOR SWING' : 'NOT ARMED'}
          </span>
        </div>
      </div>

      {/* ── Radar live readout ──────────────────────────────────── */}
      {radarStatus && connected && (
        <RadarCard radar={radarStatus} />
      )}

      {/* ── Pipeline state ───────────────────────────────────────── */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>PIPELINE</div>
        <PipelineStates state={status.state} latencyMs={status.latencyMs} />
      </div>

      {/* ── Strike zone (last few swings of the session) ────────── */}
      {swings.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <StrikeZone
            points={buildZonePoints(swings, swings[0])}
            title={swings[0].ball.pitch ? 'PITCH STRIKE ZONE' : 'CONTACT STRIKE ZONE'}
          />
        </div>
      )}

      {/* ── Last measurement ─────────────────────────────────────── */}
      {lastBall && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>LAST SWING</div>
          <div style={styles.metricsRow}>
            <Metric label="EXIT VEL"  value={lastBall.exitVelocity.toFixed(2)}                  unit="mph" color="#ff6644" />
            <Metric label="LAUNCH ∠"  value={lastBall.radarOnly ? '—' : lastBall.launchAngle.toFixed(2)}  unit="°"   color="#44aaff" />
            <Metric label="SPRAY ∠"   value={lastBall.radarOnly ? '—' : lastBall.sprayAngle.toFixed(2)}   unit="°"   color="#44ff88" />
            <Metric
              label="CARRY"
              value={lastBall.carryDistanceM != null
                ? (lastBall.carryDistanceM * 3.28084).toFixed(1)
                : '—'}
              unit="ft"
              color="#ffaa44"
            />
            <Metric label="DETECT"    value={`${(lastBall.detectRate * 100).toFixed(1)}`}       unit="%"
              color={lastBall.detectRate >= 0.7 ? '#44ff88' : lastBall.detectRate >= 0.4 ? '#ffaa00' : '#ff4455'} />
            <Metric label="LATENCY"   value={`${lastBall.processingLatencyMs.toFixed(0)}`}      unit="ms"  color="#aaaacc" />
          </div>
        </div>
      )}

      {/* ── Setup guide (shown when disconnected) ────────────────── */}
      {!connected && (
        <div style={styles.guide}>
          <div style={styles.guideTitle}>GETTING STARTED</div>
          <ol style={styles.guideList}>
            <li>In the <code style={styles.code}>nuc\</code> folder run: <code style={styles.code}>python main.py</code></li>
            <li>Enter the monitor's WebSocket URL above (default ws://localhost:8765)</li>
            <li>Click CONNECT — the status dot will turn green</li>
            <li>If not yet calibrated, run <code style={styles.code}>python plate_calib.py --live</code> (see the Calibrate tab)</li>
            <li>Click ARM, then swing</li>
          </ol>
        </div>
      )}
    </div>
  );
}

function RadarCard({ radar }: {
  radar: { pitchMph: number | null; evMph: number | null; rangeM: number | null; receivedAt: number };
}): React.ReactElement {
  // Grey the readout if the radar hasn't sent an update in > 2 s
  const stale = Date.now() - radar.receivedAt > 2000;
  const col = (v: number | null, accent: string) =>
    stale ? '#888888' : v != null ? accent : '#aaaaaa';
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>RADAR (OPS243){stale && ' — stale'}</div>
      <div style={{ display: 'flex', gap: 24, paddingTop: 4, justifyContent: 'center' }}>
        <RadarMetric label="PITCH"
          value={radar.pitchMph != null ? radar.pitchMph.toFixed(1) : '—'}
          unit="mph" color={col(radar.pitchMph, '#44aaff')} />
        <RadarMetric label="EXIT VEL"
          value={radar.evMph != null ? radar.evMph.toFixed(1) : '—'}
          unit="mph" color={col(radar.evMph, '#ff6644')} />
        <RadarMetric label="RANGE"
          value={radar.rangeM != null ? (radar.rangeM * 3.281).toFixed(1) : '—'}
          unit="ft" color={col(radar.rangeM, '#44ff88')} />
      </div>
    </div>
  );
}

function RadarMetric({ label, value, unit, color }: {
  label: string; value: string; unit: string; color: string;
}) {
  return (
    <div style={{ textAlign: 'center', minWidth: 72 }}>
      <div style={{ fontSize: 9, color: '#909498', letterSpacing: '0.12em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: '#c0c4cc', marginTop: 1 }}>{unit}</div>
    </div>
  );
}

const PIPELINE_STEPS = ['idle', 'armed', 'capturing', 'processing'] as const;
const STEP_LABELS: Record<string, string> = {
  idle: 'Idle', armed: 'Armed', capturing: 'Capturing', processing: 'Processing',
};

function PipelineStates({ state, latencyMs }: { state: string; latencyMs: number }) {
  const activeIdx = PIPELINE_STEPS.indexOf(state as typeof PIPELINE_STEPS[number]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {PIPELINE_STEPS.map((step, i) => {
        const active  = step === state;
        const done    = i < activeIdx;
        const color   = active ? '#44aaff' : done ? '#44ff88' : '#1a1a2e';
        const txtColor = active ? '#44aaff' : done ? '#44ff88' : '#e0e4ec';
        return (
          <React.Fragment key={step}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: color, margin: '0 auto 4px',
                boxShadow: active ? `0 0 8px ${color}` : 'none',
                transition: 'all 0.2s',
              }} />
              <div style={{ fontSize: 8, color: txtColor, letterSpacing: '0.08em' }}>
                {STEP_LABELS[step]}
              </div>
            </div>
            {i < PIPELINE_STEPS.length - 1 && (
              <div style={{
                flex: 1, height: 1,
                background: done ? '#44ff88' : '#1a1a2e',
                margin: '-8px 6px 0',
                transition: 'background 0.2s',
              }} />
            )}
          </React.Fragment>
        );
      })}
      {latencyMs > 0 && (
        <div style={{ marginLeft: 16, fontSize: 10, color: '#c0c4cc' }}>
          {latencyMs.toFixed(0)} ms
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 80 }}>
      <div style={{ fontSize: 9, color: '#d0d4dc', letterSpacing: '0.12em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: '#c0c4cc', marginTop: 1 }}>{unit}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 20,
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
  },
  sessionBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: '#041a08',
    border: '1px solid #1a4a20',
    borderRadius: 6,
    padding: '10px 14px',
  },
  sessionLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sessionMode: {
    fontSize: 10,
    fontWeight: 700,
    color: '#44ff88',
    letterSpacing: '0.12em',
  },
  sessionSep: {
    color: '#2a4a30',
  },
  sessionType: {
    fontSize: 12,
    fontWeight: 700,
    color: '#321',
    letterSpacing: '0.08em',
  },
  sessionEnd: {
    background: 'transparent',
    color: '#c0c4cc',
    border: '1px solid #1a2a20',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.12em',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  noSessionBar: {
    background: '#0a0a18',
    border: '1px dashed #1a3a6e',
    borderRadius: 6,
    padding: '10px 14px',
    color: '#55aaff',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  card: {
    background: '#0d0d18',
    border: '1px solid #1a1a2e',
    borderRadius: 8,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  cardTitle: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#d0d4dc',
    marginBottom: 2,
  },
  hostRow: {
    display: 'flex',
    gap: 8,
  },
  hostInput: {
    flex: 1,
    background: '#07070f',
    border: '1px solid #1a1a2e',
    borderRadius: 4,
    color: '#554433',
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '5px 10px',
    outline: 'none',
  },
  wsStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
  errorMsg: {
    fontSize: 10,
    color: '#ff4455',
    background: '#1a0010',
    border: '1px solid #441020',
    borderRadius: 4,
    padding: '4px 8px',
  },
  triggerRow: {
    display: 'flex',
    gap: 8,
  },
  armedIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  metricsRow: {
    display: 'flex',
    gap: 24,
    justifyContent: 'center',
    paddingTop: 4,
  },
  btnPrimary: {
    padding: '7px 16px',
    background: '#002244',
    color: '#66aaff',
    border: '1px solid #1a3a6e',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
  },
  btnTrigger: {
    padding: '7px 18px',
    background: '#3a1d00',
    color: '#ffaa44',
    border: '1px solid #5a3010',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.1em',
    fontFamily: 'inherit',
  },
  btnDanger: {
    padding: '7px 16px',
    background: '#220010',
    color: '#ff6688',
    border: '1px solid #441030',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
  },
  btnSecondary: {
    padding: '7px 14px',
    background: '#0d0d14',
    color: '#667788',
    border: '1px solid #1a1a2e',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
  },
  guide: {
    background: '#07070f',
    border: '1px solid #111',
    borderRadius: 8,
    padding: '14px 16px',
  },
  guideTitle: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#e0e4ec',
    marginBottom: 8,
  },
  guideList: {
    margin: 0,
    paddingLeft: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 11,
    color: '#d0d4dc',
    lineHeight: 1.5,
  },
  code: {
    background: '#f0f0f0',
    border: '1px solid #1a1a2e',
    borderRadius: 3,
    padding: '1px 5px',
    fontFamily: 'inherit',
    color: '#88aaff',
    fontSize: 11,
  },
};
