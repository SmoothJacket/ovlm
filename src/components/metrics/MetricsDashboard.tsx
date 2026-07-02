import React, { useCallback, useMemo, useRef, useState } from 'react';
import GridLayout, { useContainerWidth, type LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

import { useStore, useSwings, useActiveSwing, useLatestHitSwing, useLatestPitchSwing } from '@/state/store';
import type { SwingSession, SubSessionType } from '@/types/pipeline';
import { SUB_SESSION_LABELS } from '@/state/drill-session.slice';
import { piClient } from '@/ws/client';
import {
  HITTING_SESSIONS, PITCHING_SESSIONS, sessionLabel,
} from '../session/SessionTypeSelector';
import type { SessionType } from '@/state/session-mode.slice';
import { BiomechPanel } from './BiomechPanel';
import { EVChart } from './EVChart';
import { SprayChart } from './SprayChart';
import { StrikeZone, buildZonePoints } from './StrikeZone';
import {
  openSimulator, sendSwingToSimulator, getAutoSend, setAutoSend,
} from '@/integrations/simulator';

// ── Constants ─────────────────────────────────────────────────────────────────
const COLS  = 12;
const ROW_H = 54;
const LS_LAYOUT_HIT = 'ovlm_layout_v3_hit';
const LS_LAYOUT_PIT = 'ovlm_layout_v3_pit';
const LS_MODE       = 'ovlm_metrics_mode_v1';
const MPH_TO_KPH    = 1.60934;

type Mode = 'hitting' | 'pitching';

// ── Default layouts ───────────────────────────────────────────────────────────
const DEFAULT_HIT: LayoutItem[] = [
  { i: 'session',     x: 0,  y: 0,  w: 2, h: 6,  minW: 2, minH: 5 },
  { i: 'swing-list',  x: 0,  y: 6,  w: 2, h: 8,  minW: 2, minH: 4 },
  { i: 'ev-chart',    x: 2,  y: 0,  w: 8,  h: 4, minW: 4, minH: 3 },
  { i: 'radar-ev',    x: 10, y: 0,  w: 2,  h: 4, minW: 2, minH: 2 },
  { i: 'hit-ev',      x: 2,  y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'hit-la',      x: 4,  y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'hit-sa',      x: 6,  y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'hit-carry',   x: 8,  y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'hit-quality', x: 10, y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'hit-spin',    x: 2,  y: 7,  w: 3, h: 5,  minW: 2, minH: 3 },
  { i: 'hit-spray',   x: 5,  y: 7,  w: 4, h: 7,  minW: 3, minH: 5 },
  { i: 'hit-zone',    x: 9,  y: 7,  w: 3, h: 7,  minW: 3, minH: 5 },
];

const DEFAULT_PIT: LayoutItem[] = [
  { i: 'session',      x: 0,  y: 0,  w: 2, h: 6,  minW: 2, minH: 5 },
  { i: 'swing-list',   x: 0,  y: 6,  w: 2, h: 10, minW: 2, minH: 4 },
  { i: 'ev-chart',     x: 2,  y: 0,  w: 8,  h: 4, minW: 4, minH: 3 },
  { i: 'radar-ev',     x: 10, y: 0,  w: 2,  h: 4, minW: 2, minH: 2 },
  { i: 'pit-speed',    x: 2,  y: 4,  w: 3, h: 3,  minW: 2, minH: 2 },
  { i: 'pit-movement', x: 5,  y: 4,  w: 3, h: 3,  minW: 2, minH: 2 },
  { i: 'pit-angles',   x: 8,  y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'pit-time',     x: 10, y: 4,  w: 2, h: 3,  minW: 2, minH: 2 },
  { i: 'pit-release',  x: 2,  y: 7,  w: 3, h: 4,  minW: 2, minH: 3 },
  { i: 'pit-spin',     x: 5,  y: 7,  w: 4, h: 4,  minW: 3, minH: 3 },
  { i: 'pit-location', x: 9,  y: 7,  w: 3, h: 7,  minW: 3, minH: 5 },
];

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadLayout(key: string, defaults: LayoutItem[]): LayoutItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as LayoutItem[];
  } catch {}
  return [...defaults];
}

function saveLayout(key: string, layout: readonly LayoutItem[]): void {
  try { localStorage.setItem(key, JSON.stringify(layout)); } catch {}
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtEv(ev: number, unit: 'mph' | 'kph'): string {
  return (unit === 'kph' ? ev * MPH_TO_KPH : ev).toFixed(2);
}
function evNote(ev: number): string {
  if (ev >= 110) return 'Elite power';
  if (ev >= 100) return 'Above average';
  if (ev >=  90) return 'Average MLB';
  return 'Below average';
}
function laNote(la: number, min = 8, max = 32): string {
  if (la >= min && la <= max) return 'Optimal range';
  if (la < 0) return 'Ground ball';
  if (la > 40) return 'Pop up';
  return '';
}
function saNote(sa: number): string {
  if (Math.abs(sa) < 10) return 'Center';
  if (sa > 15) return 'Pull side';
  if (sa < -15) return 'Oppo';
  return '';
}

function exportCsv(swings: SwingSession[]): void {
  const header = [
    'swing', 'timestamp', 'exit_velocity_mph', 'launch_angle_deg',
    'spray_angle_deg', 'spin_rate_rpm', 'detect_rate_pct', 'latency_ms',
  ].join(',');
  const rows = [...swings].reverse().map((sw, i) => [
    i + 1,
    new Date(sw.timestamp).toISOString(),
    sw.ball.exitVelocity, sw.ball.launchAngle, sw.ball.sprayAngle,
    sw.ball.seam?.spinRate ?? '',
    (sw.ball.detectRate * 100).toFixed(1),
    sw.ball.processingLatencyMs.toFixed(0),
  ].join(','));
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `ovlm_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Widget shell ──────────────────────────────────────────────────────────────
function Widget({ title, children, scrollable = false }: {
  title: string;
  children: React.ReactNode;
  scrollable?: boolean;
}) {
  return (
    <div style={ws.root}>
      <div className="widget-handle" style={ws.handle}>
        <span style={ws.handleTitle}>{title}</span>
        <span style={ws.grip}>⠿</span>
      </div>
      <div style={{ ...ws.body, overflowY: scrollable ? 'auto' : 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

const ws: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100%', background: '#0d0d18',
    border: '1px solid #1a1a2e', borderRadius: 8,
    overflow: 'hidden', boxSizing: 'border-box',
  },
  handle: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '5px 10px', background: '#111122',
    borderBottom: '1px solid #1a1a2e', cursor: 'grab', flexShrink: 0,
    userSelect: 'none',
  },
  handleTitle: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
    color: '#88aacc', flex: 1,
  },
  grip: { fontSize: 14, color: '#333a5a', lineHeight: 1 },
  body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
};

// ── Big number card ───────────────────────────────────────────────────────────
function BigNum({ label, value, unit, color, sub, badge, badgeColor }: {
  label: string; value: string; unit: string; color: string;
  sub?: string; badge?: string; badgeColor?: string;
}) {
  return (
    <div style={bn.root}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={bn.label}>{label}</span>
        {badge && (
          <span style={{ ...bn.badge, borderColor: badgeColor ?? '#4488ff', color: badgeColor ?? '#4488ff' }}>
            {badge}
          </span>
        )}
      </div>
      <div style={{ ...bn.value, color }}>
        {value}<span style={bn.unit}> {unit}</span>
      </div>
      {sub && <div style={bn.sub}>{sub}</div>}
    </div>
  );
}
const bn: Record<string, React.CSSProperties> = {
  root: { padding: '10px 14px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  label: { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: '#d0d4dc' },
  value: { fontSize: 32, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', marginTop: 4 },
  unit: { fontSize: 12, opacity: 0.6 },
  sub: { fontSize: 9, color: '#c0c4cc', marginTop: 3 },
  badge: { fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', border: '1px solid', borderRadius: 3, padding: '1px 4px' },
};

// ── Two-value metric row ──────────────────────────────────────────────────────
function MetricRow({ items }: { items: Array<{ label: string; value: string; unit: string; color?: string }> }) {
  return (
    <div style={{ display: 'flex', flex: 1, padding: '8px 14px', gap: 12 }}>
      {items.map(it => (
        <div key={it.label} style={{ flex: 1 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>{it.label}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: it.color ?? '#e0e4ec', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2, marginTop: 2 }}>
            {it.value}<span style={{ fontSize: 10, opacity: 0.6 }}> {it.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Session widget ────────────────────────────────────────────────────────────
const SUB_TYPES: SubSessionType[] = ['tee', 'front_toss', 'live_bp'];
const SUB_COLORS: Record<SubSessionType, string> = {
  tee:        '#44aaff',
  front_toss: '#ffaa44',
  live_bp:    '#44ff88',
};

function SessionWidget({ onModeSwitch }: { onModeSwitch: (m: Mode) => void }) {
  const masterSession    = useStore(s => s.masterSession);
  const activeSubSession = useStore(s => s.activeSubSession);
  const subSessions      = useStore(s => s.subSessions);
  const activeSession    = useStore(s => s.activeSession);
  const swings           = useSwings();
  const startMaster      = useStore(s => s.startMasterSession);
  const endMaster        = useStore(s => s.endMasterSession);
  const startSub         = useStore(s => s.startSubSession);
  const endSub           = useStore(s => s.endSubSession);
  const startSession     = useStore(s => s.startSession);

  const [pickedMode, setPickedMode] = useState<Mode | null>(null);

  const swingsBySubSession = (id?: string) =>
    id ? swings.filter(sw => sw.subSessionId === id) : [];

  const masterSwings = swings.filter(sw =>
    masterSession && sw.timestamp >= masterSession.startedAt && !sw.ball.pitch,
  );
  const masterMaxEv = masterSwings.length
    ? Math.max(...masterSwings.map(sw => sw.ball.exitVelocity))
    : null;

  const elapsed = masterSession
    ? Math.floor((Date.now() - masterSession.startedAt) / 60000)
    : 0;

  // ── Step 1: pick mode ──────────────────────────────────────────────────────
  if (!masterSession && !pickedMode) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 }}>
        <div style={{ fontSize: 9, color: '#556677', letterSpacing: '0.1em', marginBottom: 4 }}>SELECT MODE</div>
        <button style={sBtn('#4488ff', '#050a1a')} onClick={() => setPickedMode('hitting')}>
          ⚾  HITTING
        </button>
        <button style={sBtn('#ff8844', '#1a0a05')} onClick={() => setPickedMode('pitching')}>
          ◎  PITCHING
        </button>
      </div>
    );
  }

  // ── Step 2: pick session type ──────────────────────────────────────────────
  if (!masterSession && pickedMode) {
    const sessions = pickedMode === 'hitting' ? HITTING_SESSIONS : PITCHING_SESSIONS;
    const accentColor = pickedMode === 'hitting' ? '#4488ff' : '#ff8844';
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #1a1a2e', flexShrink: 0 }}>
          <button
            style={{ background: 'none', border: 'none', color: '#556677', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, padding: 0 }}
            onClick={() => setPickedMode(null)}
          >
            ← Back
          </button>
          <span style={{ fontSize: 9, color: accentColor, fontWeight: 700, letterSpacing: '0.12em' }}>
            {pickedMode.toUpperCase()}
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sessions.map(sess => (
            <button
              key={sess.id}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3,
                padding: '8px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                border: '1px solid #1a1a2e', background: '#0a0a18', textAlign: 'left', width: '100%',
              }}
              onClick={() => {
                startMaster();
                startSession(pickedMode, sess.id);
                piClient.send({ type: 'set_session_mode', mode: pickedMode });
                onModeSwitch(pickedMode);
                setPickedMode(null);
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, color: accentColor }}>{sess.icon}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#ccd0d8', letterSpacing: '0.08em' }}>{sess.label}</span>
              </div>
              <div style={{ fontSize: 8, color: '#778899', lineHeight: 1.4 }}>{sess.blurb}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Step 3: active session ─────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Master session header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #1a1a2e', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 9, color: '#44ff88', fontWeight: 700, letterSpacing: '0.12em' }}>
              {activeSession?.mode?.toUpperCase() ?? 'SESSION'}
            </div>
            <div style={{ fontSize: 8, color: '#aabbcc', fontWeight: 700 }}>
              {activeSession ? sessionLabel(activeSession.type) : ''}
            </div>
            <div style={{ fontSize: 8, color: '#556677' }}>
              {masterSession!.date} · {elapsed}m
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: '#aabbcc' }}>{masterSwings.length} swings</div>
            {masterMaxEv != null && (
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ff6644', fontVariantNumeric: 'tabular-nums' }}>
                {masterMaxEv.toFixed(1)} max
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sub-session buttons */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5, flex: 1, overflowY: 'auto' }}>
        <div style={{ fontSize: 8, color: '#556677', letterSpacing: '0.1em', marginBottom: 2 }}>DRILL</div>
        {SUB_TYPES.map(type => {
          const isActive = activeSubSession?.type === type;
          const past = subSessions.filter(s => s.type === type);
          const pastSwings = past.flatMap(s => swingsBySubSession(s.id)).filter(sw => !sw.ball.pitch);
          const color = SUB_COLORS[type];
          return (
            <button
              key={type}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${isActive ? color : '#1a1a2e'}`,
                background: isActive ? `${color}18` : 'transparent',
              }}
              onClick={() => isActive ? endSub() : startSub(type)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: isActive ? color : '#334', flexShrink: 0 }} />
                <span style={{ fontSize: 9, fontWeight: 700, color: isActive ? color : '#aabbcc', letterSpacing: '0.08em' }}>
                  {SUB_SESSION_LABELS[type]}
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                {pastSwings.length > 0 && (
                  <span style={{ fontSize: 8, color: '#778899' }}>
                    {pastSwings.length}{` · ${Math.max(...pastSwings.map(sw => sw.ball.exitVelocity)).toFixed(0)} max`}
                  </span>
                )}
                {isActive && <span style={{ fontSize: 8, color, marginLeft: 4 }}>● ACTIVE</span>}
              </div>
            </button>
          );
        })}

        {activeSubSession && (
          <button style={{ ...sBtn('#ff4455', '#1a0010'), marginTop: 4, fontSize: 8 }} onClick={endSub}>
            ⬛ End {activeSubSession.label}
          </button>
        )}
      </div>

      {/* End session */}
      <div style={{ padding: '6px 10px', borderTop: '1px solid #1a1a2e' }}>
        <button style={{ ...sBtn('#ff4455', '#1a0010'), width: '100%' }} onClick={() => {
          endMaster();
          setPickedMode(null);
        }}>
          END SESSION
        </button>
      </div>
    </div>
  );
}

function sBtn(color: string, bg: string): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 5, border: `1px solid ${color}33`,
    background: bg, color, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
    cursor: 'pointer', fontFamily: 'inherit', width: '100%',
  };
}

// ── Swing list widget ─────────────────────────────────────────────────────────
function SwingListWidget({ mode }: { mode: Mode }) {
  const swings = useSwings();
  const active = useActiveSwing();
  const setActive = useStore(s => s.setActiveSwing);
  const [autoSendState, setAutoSendState] = useState(getAutoSend());
  const { evUnit } = useStore(s => s.settings);
  const activeSubSession = useStore(s => s.activeSubSession);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {swings.length === 0 ? (
          <div style={{ padding: 14, fontSize: 10, color: '#c0c4cc', textAlign: 'center' }}>
            No swings yet
          </div>
        ) : swings.map((sw, i) => {
          const isPitch = sw.ball.pitch != null;
          if (mode === 'hitting'  && isPitch) return null;
          if (mode === 'pitching' && !isPitch) return null;
          return (
            <div key={sw.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', cursor: 'pointer',
                borderBottom: '1px solid #0d0d18',
                background: sw.id === active?.id ? '#131326' : 'transparent',
                opacity: activeSubSession && sw.subSessionId !== activeSubSession.id ? 0.35 : 1,
              }}
              onClick={() => setActive(sw.id)}
            >
              {sw.subSessionType && (
                <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, flexShrink: 0,
                  background: SUB_COLORS[sw.subSessionType] }} />
              )}
              <div style={{ fontSize: 9, color: '#556', width: 20, textAlign: 'right', flexShrink: 0 }}>
                #{swings.length - i}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#cc8844', fontVariantNumeric: 'tabular-nums' }}>
                  {isPitch
                    ? `${sw.ball.pitch!.releaseSpeedMph.toFixed(1)} mph`
                    : `${fmtEv(sw.ball.exitVelocity, evUnit)} ${evUnit}`}
                </div>
                <div style={{ fontSize: 9, color: '#c0c4cc' }}>
                  {isPitch
                    ? `LA: ${sw.ball.launchAngle}° · ${sw.ball.pitch!.verticalBreakIn.toFixed(1)}" VB`
                    : sw.ball.radarOnly
                      ? `radar only · ${new Date(sw.timestamp).toLocaleTimeString()}`
                      : `LA: ${sw.ball.launchAngle}° · ${new Date(sw.timestamp).toLocaleTimeString()}`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '8px 10px', borderTop: '1px solid #111', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <button style={swBtn} onClick={() => exportCsv(swings)}>↓ Export CSV</button>
        <button style={{ ...swBtn, color: '#cc8844', borderColor: '#2a1f10' }}
          onClick={() => (active ? sendSwingToSimulator(active.ball) : openSimulator())}>
          ⚾ {active ? 'Replay in Sim' : 'Open Sim'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: '#c0c4cc', cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={autoSendState}
            onChange={e => { setAutoSend(e.target.checked); setAutoSendState(e.target.checked); }}
            style={{ margin: 0 }} />
          Auto-send
        </label>
      </div>
    </div>
  );
}
const swBtn: React.CSSProperties = {
  width: '100%', padding: '5px 0', background: 'transparent',
  border: '1px solid #1a2a1a', borderRadius: 4, color: '#d0d4dc',
  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', cursor: 'pointer', fontFamily: 'inherit',
};

// ── Hitting metric widgets ────────────────────────────────────────────────────
function HitEV() {
  const sw = useLatestHitSwing();
  const unit = useStore(s => s.settings.evUnit);
  if (!sw) return <BigNum label="EXIT VELOCITY" value="--" unit={unit} color="#334" />;
  return <BigNum label="EXIT VELOCITY" value={fmtEv(sw.ball.exitVelocity, unit)} unit={unit}
    color="#ff6644" sub={evNote(sw.ball.exitVelocity)}
    badge={sw.ball.evSource === 'radar' ? 'RADAR' : undefined} badgeColor="#44aaff" />;
}

function HitLA() {
  const sw = useLatestHitSwing();
  const { laOptimalMin = 8, laOptimalMax = 32 } = useStore(s => s.settings);
  if (!sw || sw.ball.radarOnly) return <BigNum label="LAUNCH ANGLE" value="--" unit="°" color="#334" />;
  const note = laNote(sw.ball.launchAngle, laOptimalMin, laOptimalMax);
  const inRange = sw.ball.launchAngle >= laOptimalMin && sw.ball.launchAngle <= laOptimalMax;
  const color = inRange ? '#44ff88' : sw.ball.launchAngle < 0 ? '#ff4455' : '#44aaff';
  return <BigNum label="LAUNCH ANGLE" value={sw.ball.launchAngle.toFixed(2)} unit="°" color={color} sub={note} />;
}

function HitSA() {
  const sw = useLatestHitSwing();
  if (!sw || sw.ball.radarOnly) return <BigNum label="SPRAY ANGLE" value="--" unit="°" color="#334" />;
  return <BigNum label="SPRAY ANGLE" value={sw.ball.sprayAngle.toFixed(2)} unit="°"
    color="#44ff88" sub={saNote(sw.ball.sprayAngle)} />;
}

function HitCarry() {
  const sw = useLatestHitSwing();
  if (!sw) return <BigNum label="CARRY DISTANCE" value="--" unit="ft" color="#334" />;
  const carry = sw.ball.carryDistanceM;
  return (
    <BigNum
      label="CARRY DISTANCE"
      value={carry != null ? (carry * 3.281).toFixed(0) : '--'}
      unit="ft"
      color="#2dd4bf"
      sub={carry != null ? `${carry.toFixed(1)} m` : 'no carry data'}
    />
  );
}

function HitQuality() {
  const sw = useLatestHitSwing();
  if (!sw) return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, justifyContent: 'center' }}>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>DETECT RATE</div>
        <div style={{ fontSize: 28, fontWeight: 700, color: '#334' }}>--</div>
      </div>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>LATENCY</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#334' }}>--</div>
      </div>
    </div>
  );
  const dr = sw.ball.detectRate;
  return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, justifyContent: 'center' }}>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>DETECT RATE</div>
        <div style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
          color: dr >= 0.7 ? '#44ff88' : dr >= 0.4 ? '#ffaa00' : '#ff4455' }}>
          {(dr * 100).toFixed(0)}<span style={{ fontSize: 11, opacity: 0.6 }}> %</span>
        </div>
        {dr < 0.4 && <div style={{ fontSize: 9, color: '#ff8855' }}>Low — check exposure</div>}
      </div>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>LATENCY</div>
        <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
          color: sw.ball.processingLatencyMs > 400 ? '#ff4455' : '#44ff88' }}>
          {sw.ball.processingLatencyMs.toFixed(0)}<span style={{ fontSize: 11, opacity: 0.6 }}> ms</span>
        </div>
      </div>
    </div>
  );
}

function HitSpin() {
  const sw = useLatestHitSwing();
  if (!sw || !sw.ball.seam) return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>TOTAL SPIN</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#334' }}>-- <span style={{ fontSize: 9, opacity: 0.6 }}>rpm</span></span>
      </div>
      <div style={{ fontSize: 9, color: '#334', paddingTop: 4 }}>{sw ? 'No spin data' : ''}</div>
    </div>
  );
  const { seam, launchAngle: la, sprayAngle: sa } = sw.ball;

  // Decompose spin axis into backspin/sidespin via Magnus: F = axis × v_hat
  const laR = la * Math.PI / 180, saR = sa * Math.PI / 180;
  const vx = Math.sin(saR) * Math.cos(laR);
  const vy = Math.sin(laR);
  const vz = Math.cos(saR) * Math.cos(laR);
  const [ax, ay, az] = seam.spinAxis;
  const Fx = ay * vz - az * vy;
  const Fy = az * vx - ax * vz;
  const FMag = Math.sqrt(Fx * Fx + Fy * Fy + (ax * vy - ay * vx) ** 2);
  const backspin = FMag > 0.01 ? Math.round(seam.spinRate * Fy) : 0;
  const sidespin = FMag > 0.01 ? Math.round(seam.spinRate * Fx) : 0;

  return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>TOTAL SPIN</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#aa88ff', fontVariantNumeric: 'tabular-nums' }}>
          {seam.spinRate.toLocaleString()} <span style={{ fontSize: 9, opacity: 0.6 }}>rpm</span>
        </span>
      </div>
      <div style={{ borderTop: '1px solid #1a1a2e', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SpinRow label={backspin >= 0 ? 'BACKSPIN' : 'TOPSPIN'}
          value={Math.abs(backspin)} color={backspin >= 0 ? '#34d399' : '#f87171'} />
        <SpinRow label={`SIDESPIN → ${sidespin >= 0 ? '1B' : '3B'}`}
          value={Math.abs(sidespin)} color="#38bdf8" />
      </div>
      <div style={{ fontSize: 8, color: '#445', textAlign: 'right' }}>
        {seam.confidence != null ? `conf: ${(seam.confidence * 100).toFixed(0)}% · ` : ''}source: magnus
      </div>
    </div>
  );
}
function SpinRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: 8, color: '#8899aa', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
        {value.toLocaleString()} <span style={{ fontSize: 8, opacity: 0.6 }}>rpm</span>
      </span>
    </div>
  );
}

// ── Pitching metric widgets ───────────────────────────────────────────────────
function PitSpeed() {
  const sw = useLatestPitchSwing();
  if (!sw?.ball.pitch) return (
    <MetricRow items={[
      { label: 'RELEASE SPEED', value: '--', unit: 'mph', color: '#334' },
      { label: 'PLATE SPEED',   value: '--', unit: 'mph', color: '#334' },
    ]} />
  );
  const p = sw.ball.pitch;
  return (
    <MetricRow items={[
      { label: 'RELEASE SPEED', value: p.releaseSpeedMph.toFixed(1), unit: 'mph', color: '#ff6644' },
      { label: 'PLATE SPEED',   value: p.plateSpeedMph.toFixed(1),   unit: 'mph', color: '#ff8866' },
    ]} />
  );
}

function PitMovement() {
  const sw = useLatestPitchSwing();
  if (!sw?.ball.pitch) return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, justifyContent: 'center' }}>
      <MRow label="VERT BREAK"  value="--" color="#334" />
      <MRow label="HORIZ BREAK" value="--" color="#334" />
      <MRow label="TOTAL BREAK" value="--" color="#334" />
    </div>
  );
  const p = sw.ball.pitch;
  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, justifyContent: 'center' }}>
      <MRow label="VERT BREAK"  value={`${p.verticalBreakIn.toFixed(1)}"`}   color="#ffaa44" />
      <MRow label="HORIZ BREAK" value={`${p.horizontalBreakIn.toFixed(1)}"`} color="#ffaa44" />
      <MRow label="TOTAL BREAK" value={`${p.totalBreakIn.toFixed(1)}"`}      color="#ffcc66" />
    </div>
  );
}

function PitAngles() {
  const sw = useLatestPitchSwing();
  if (!sw?.ball.pitch) return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
      <MRow label="VAA" value="--" color="#334" />
      <MRow label="HAA" value="--" color="#334" />
    </div>
  );
  const p = sw.ball.pitch;
  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
      <MRow label="VAA" value={`${p.vaaDeg.toFixed(2)}°`} color="#88aaff" />
      <MRow label="HAA" value={`${p.haaDeg.toFixed(2)}°`} color="#88aaff" />
    </div>
  );
}

function PitTime() {
  const sw = useLatestPitchSwing();
  if (!sw?.ball.pitch) return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
      <MRow label="PLATE TIME" value="--" color="#334" />
      <MRow label="PLATE LOC"  value="--" color="#334" />
    </div>
  );
  const p = sw.ball.pitch;
  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
      <MRow label="PLATE TIME" value={`${(p.plateTimeS * 1000).toFixed(0)} ms`}                      color="#aaaacc" />
      <MRow label="PLATE LOC"  value={`${p.plateLocXFt.toFixed(1)}, ${p.plateLocYFt.toFixed(1)} ft`} color="#8899aa" />
    </div>
  );
}

function PitRelease() {
  const sw = useLatestPitchSwing();
  if (!sw?.ball.pitch) return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, justifyContent: 'center' }}>
      <MRow label="EXTENSION"      value="--" color="#334" />
      <MRow label="RELEASE HEIGHT" value="--" color="#334" />
      <MRow label="RELEASE SIDE"   value="--" color="#334" />
    </div>
  );
  const p = sw.ball.pitch;
  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, justifyContent: 'center' }}>
      <MRow label="EXTENSION"      value={`${p.extensionFt.toFixed(2)} ft`}      color="#44aaff" />
      <MRow label="RELEASE HEIGHT" value={`${p.releaseHeightFt.toFixed(2)} ft`}  color="#44aaff" />
      <MRow label="RELEASE SIDE"   value={`${p.releaseSideFt.toFixed(2)} ft`}    color="#44aaff" />
    </div>
  );
}

function PitSpin() {
  const sw = useLatestPitchSwing();
  if (!sw?.ball.pitch) return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, justifyContent: 'center' }}>
      <MRow label="SPIN RATE"   value="--" color="#334" />
      <MRow label="TILT"        value="--" color="#334" />
      <MRow label="ACTIVE SPIN" value="--" color="#334" />
    </div>
  );
  const p = sw.ball.pitch;
  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1, justifyContent: 'center' }}>
      {p.spinRateRpm   != null && <MRow label="SPIN RATE"   value={`${p.spinRateRpm.toLocaleString()} rpm`} color="#aa88ff" />}
      {p.spinTilt      != null && <MRow label="TILT"        value={p.spinTilt}                              color="#aa88ff" />}
      {p.activeSpinPct != null && <MRow label="ACTIVE SPIN" value={`${p.activeSpinPct.toFixed(0)}%`}       color="#ffaa44" />}
      {p.spinRateRpm == null && <MRow label="SPIN RATE" value="--" color="#334" />}
    </div>
  );
}

function MRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: '#d0d4dc' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

// ── Live radar EV widget ──────────────────────────────────────────────────────
function RadarEvWidget({ mode }: { mode: Mode }) {
  const radar        = useStore(s => s.radarStatus);
  const stale        = !radar || (Date.now() - radar.receivedAt > 6000);
  const ev           = radar?.evMph    ?? null;
  const pitch        = radar?.pitchMph ?? null;
  const isPitching   = mode === 'pitching';
  const col          = (v: number | null, active: string) => stale || v == null ? '#334' : active;
  const primaryVal   = isPitching ? pitch : ev;
  const primaryLabel = isPitching ? 'PITCH SPEED' : 'RADAR EV';
  const primaryColor = isPitching ? '#44aaff' : '#ff6644';
  const secVal       = isPitching ? ev    : pitch;
  const secLabel     = isPitching ? 'EV'  : 'PITCH';
  const secColor     = isPitching ? '#ff6644' : '#44aaff';
  return (
    <div style={{ padding: '10px 14px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: stale ? '#445' : primaryColor }}>
          {primaryLabel}
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
          color: col(primaryVal, primaryColor) }}>
          {primaryVal != null ? primaryVal.toFixed(1) : '—'}
          <span style={{ fontSize: 11, opacity: 0.6 }}> mph</span>
        </div>
      </div>
      {secVal != null && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: stale ? '#445' : secColor }}>{secLabel}</div>
          <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
            color: col(secVal, secColor) }}>
            {secVal.toFixed(1)}<span style={{ fontSize: 10, opacity: 0.6 }}> mph</span>
          </div>
        </div>
      )}
      {radar?.rangeM != null && !stale && (
        <div style={{ fontSize: 8, color: '#556677', marginTop: 2 }}>
          {(radar.rangeM * 3.281).toFixed(1)} ft range
        </div>
      )}
    </div>
  );
}

// ── Placeholder ───────────────────────────────────────────────────────────────
function Placeholder({ text = 'Select a swing' }: { text?: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#334' }}>
      {text}
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────
export function MetricsDashboard(): React.ReactElement {
  const swings = useSwings();
  const activeSwing = useActiveSwing();
  const activeSession = useStore(s => s.activeSession);

  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(LS_MODE);
    if (saved === 'hitting' || saved === 'pitching') return saved;
    return activeSession?.mode === 'pitching' ? 'pitching' : 'hitting';
  });

  const [hitLayout, setHitLayout] = useState<LayoutItem[]>(() => loadLayout(LS_LAYOUT_HIT, DEFAULT_HIT));
  const [pitLayout, setPitLayout] = useState<LayoutItem[]>(() => loadLayout(LS_LAYOUT_PIT, DEFAULT_PIT));

  const layout = mode === 'hitting' ? hitLayout : pitLayout;

  const onLayoutChange = useCallback((newLayout: readonly LayoutItem[]) => {
    if (mode === 'hitting') {
      setHitLayout([...newLayout]);
      saveLayout(LS_LAYOUT_HIT, newLayout);
    } else {
      setPitLayout([...newLayout]);
      saveLayout(LS_LAYOUT_PIT, newLayout);
    }
  }, [mode]);

  const switchMode = (m: Mode) => {
    setMode(m);
    localStorage.setItem(LS_MODE, m);
  };

  const resetLayout = useCallback(() => {
    if (mode === 'hitting') {
      setHitLayout([...DEFAULT_HIT]);
      saveLayout(LS_LAYOUT_HIT, DEFAULT_HIT);
    } else {
      setPitLayout([...DEFAULT_PIT]);
      saveLayout(LS_LAYOUT_PIT, DEFAULT_PIT);
    }
  }, [mode]);

  const zonePoints = useMemo(() => buildZonePoints(swings, activeSwing ?? null), [swings, activeSwing]);

  // useContainerWidth measures the outer div before GridLayout renders
  const { width, containerRef, mounted } = useContainerWidth();

  return (
    <div style={ds.root}>
      {/* Mode tabs */}
      <div style={ds.tabs}>
        <button style={{ ...ds.tab, ...(mode === 'hitting'  ? ds.tabActive : {}) }} onClick={() => switchMode('hitting')}>HITTING</button>
        <button style={{ ...ds.tab, ...(mode === 'pitching' ? ds.tabActive : {}) }} onClick={() => switchMode('pitching')}>PITCHING</button>
        <div style={{ marginLeft: 'auto' }}>
          <button style={ds.resetBtn} onClick={resetLayout} title="Reset layout to default">↺ Reset layout</button>
        </div>
      </div>

      {/* Grid area */}
      <div style={ds.grid} ref={containerRef as React.Ref<HTMLDivElement>}>
        {mounted && (
          <GridLayout
            width={width}
            layout={layout}
            gridConfig={{ cols: COLS, rowHeight: ROW_H, margin: [8, 8] }}
            dragConfig={{ handle: '.widget-handle' }}
            onLayoutChange={onLayoutChange}
            autoSize
          >
            {/* ── Shared ── */}
            <div key="session">
              <Widget title="SESSION">
                <SessionWidget onModeSwitch={switchMode} />
              </Widget>
            </div>

            <div key="swing-list">
              <Widget title="SWINGS">
                <SwingListWidget mode={mode} />
              </Widget>
            </div>

            <div key="ev-chart">
              <Widget title="EV HISTORY">
                <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
                  <EVChart />
                </div>
              </Widget>
            </div>

            <div key="radar-ev">
              <Widget title="RADAR">
                <RadarEvWidget mode={mode} />
              </Widget>
            </div>

            {/* ── Hitting ── */}
            {mode === 'hitting' && <div key="hit-ev"><Widget title="EXIT VELOCITY"><HitEV /></Widget></div>}
            {mode === 'hitting' && <div key="hit-la"><Widget title="LAUNCH ANGLE"><HitLA /></Widget></div>}
            {mode === 'hitting' && <div key="hit-sa"><Widget title="SPRAY ANGLE"><HitSA /></Widget></div>}
            {mode === 'hitting' && <div key="hit-carry"><Widget title="CARRY DISTANCE"><HitCarry /></Widget></div>}
            {mode === 'hitting' && <div key="hit-quality"><Widget title="QUALITY"><HitQuality /></Widget></div>}
            {mode === 'hitting' && <div key="hit-spin"><Widget title="SPIN"><HitSpin /></Widget></div>}
            {mode === 'hitting' && (
              <div key="hit-spray">
                <Widget title="SPRAY CHART">
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    <SprayChart />
                  </div>
                </Widget>
              </div>
            )}
            {mode === 'hitting' && (
              <div key="hit-zone">
                <Widget title="CONTACT ZONE">
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    <StrikeZone points={zonePoints} title="CONTACT ZONE" />
                  </div>
                </Widget>
              </div>
            )}

            {/* ── Pitching ── */}
            {mode === 'pitching' && <div key="pit-speed"><Widget title="SPEED"><PitSpeed /></Widget></div>}
            {mode === 'pitching' && <div key="pit-movement"><Widget title="MOVEMENT"><PitMovement /></Widget></div>}
            {mode === 'pitching' && <div key="pit-angles"><Widget title="ANGLES"><PitAngles /></Widget></div>}
            {mode === 'pitching' && <div key="pit-time"><Widget title="TIMING &amp; LOCATION"><PitTime /></Widget></div>}
            {mode === 'pitching' && <div key="pit-release"><Widget title="RELEASE"><PitRelease /></Widget></div>}
            {mode === 'pitching' && <div key="pit-spin"><Widget title="SPIN"><PitSpin /></Widget></div>}
            {mode === 'pitching' && (
              <div key="pit-location">
                <Widget title="PITCH LOCATION">
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    <StrikeZone points={zonePoints} title="STRIKE ZONE" />
                  </div>
                </Widget>
              </div>
            )}
          </GridLayout>
        )}
      </div>
    </div>
  );
}

const ds: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#080810' },
  tabs: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 12px', borderBottom: '1px solid #1a1a2e', flexShrink: 0, background: '#0d0d14',
  },
  tab: {
    padding: '4px 16px', borderRadius: 5, border: '1px solid #1a1a2e',
    background: 'transparent', color: '#778899', fontSize: 10, fontWeight: 700,
    letterSpacing: '0.12em', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
  },
  tabActive: {
    background: '#131326', color: '#4488ff', borderColor: '#1a2a5e',
    boxShadow: '0 0 0 1px #1a2a5e inset',
  },
  resetBtn: {
    padding: '4px 10px', borderRadius: 5, border: '1px solid #1a1a2e',
    background: 'transparent', color: '#445566', fontSize: 9, cursor: 'pointer',
    fontFamily: 'inherit', letterSpacing: '0.08em',
  },
  grid: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
};
