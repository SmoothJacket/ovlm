import React from 'react';
import { useStore } from '@/state/store';
import { piClient } from '@/ws/client';
import type {
  CalibrationMode, SessionType,
  HittingSessionType, PitchingSessionType,
} from '@/state/session-mode.slice';

interface SessionDef {
  id:    SessionType;
  label: string;
  blurb: string;
  icon:  string;
}

const HITTING: SessionDef[] = [
  { id: 'free_hit',    label: 'FREE HIT',        icon: '◉',
    blurb: 'Open batting practice. Every swing tracked, all metrics shown.' },
  { id: 'hr_derby',    label: 'HOME RUN DERBY',  icon: '⚡',
    blurb: 'Count HRs (carry > 320 ft), keep a best-EV leaderboard.' },
  { id: 'strike_zone', label: 'STRIKE ZONE',     icon: '▣',
    blurb: 'Pitches overlaid on a regulation strike zone before contact.' },
  { id: 'game',        label: 'GAME MODE',       icon: '⚾',
    blurb: 'Simulated at-bats — balls / strikes / outs across innings.' },
];

const PITCHING: SessionDef[] = [
  { id: 'low_intent_bullpen',  label: 'LOW INTENT BULLPEN',  icon: '◎',
    blurb: 'Light throwing — mechanical work, arm care, feel. Lower intensity, location focus.' },
  { id: 'high_intent_bullpen', label: 'HIGH INTENT BULLPEN', icon: '◉',
    blurb: 'Full-effort pitches, game-speed sequences. Track velo, spin rate, and movement.' },
  { id: 'live_pitching',       label: 'LIVE PITCHING',       icon: '⚾',
    blurb: 'Pitching to live batters. Full ball/strike count and at-bat context.' },
];

export function SessionTypeSelector({ mode }: { mode: CalibrationMode }): React.ReactElement {
  const startSession = useStore((s) => s.startSession);
  const setPanel     = useStore((s) => s.setPanel);
  const sessions     = mode === 'hitting' ? HITTING : PITCHING;

  const pick = (type: SessionType) => {
    piClient.send({ type: 'set_session_mode', mode });
    startSession(mode, type);
    setPanel('metrics');
  };

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={s.eyebrow}>{mode === 'hitting' ? 'HITTING' : 'PITCHING'} CALIBRATION SAVED</span>
        <div style={s.title}>Pick a session to start</div>
      </div>

      <div style={s.grid}>
        {sessions.map((sess) => (
          <button
            key={sess.id}
            style={s.card}
            onClick={() => pick(sess.id)}
          >
            <div style={s.cardIcon}>{sess.icon}</div>
            <div style={s.cardLabel}>{sess.label}</div>
            <div style={s.cardBlurb}>{sess.blurb}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Helpers exposed for other components ──────────────────────────────────────

export function sessionLabel(type: SessionType): string {
  const all = [...HITTING, ...PITCHING];
  return all.find((s) => s.id === type)?.label ?? type.toUpperCase();
}

export { HITTING as HITTING_SESSIONS, PITCHING as PITCHING_SESSIONS };
export type { HittingSessionType, PitchingSessionType };

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
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 10,
  },
  card: {
    background: '#0a0a18',
    border: '1px solid #1a1a2e',
    borderRadius: 6,
    padding: '14px 14px',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'border-color 0.15s, background 0.15s',
  },
  cardIcon: {
    fontSize: 20,
    color: '#55aaff',
    lineHeight: 1,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: '#321',
    letterSpacing: '0.08em',
  },
  cardBlurb: {
    fontSize: 10,
    color: '#c0c4cc',
    lineHeight: 1.55,
  },
};
