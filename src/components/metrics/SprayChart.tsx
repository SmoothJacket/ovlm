/**
 * Top-down baseball field spray chart.
 *
 * Each swing is projected to an estimated landing zone using:
 *   range_m = v² × sin(2θ) / g × DRAG_K   (fly balls)
 *   range_m = v × ROLL_K × clamp(1 + θ/30) (ground balls, θ ≤ 0)
 *
 * Spray angle convention (matches world frame):
 *   0°  → center field
 *  +45° → right foul line  (first-base side)
 *  -45° → left  foul line  (third-base side)
 *
 * SVG coordinate system: origin = home plate, +x = right, -y = outfield
 * (1 SVG unit = 1 foot)
 */

import React from 'react';
import { useStore, useSwings, useActiveSwing } from '@/state/store';
import type { SwingSession } from '@/types/pipeline';

// ── Physics constants ─────────────────────────────────────────────────────────
const G        = 9.81;    // m/s²
const DRAG_K   = 0.55;    // empirical drag factor (fly balls)
const ROLL_K   = 0.55;    // empirical roll factor (ground balls, seconds of roll)
const MPH_TO_MS = 0.44704;
const M_TO_FT  = 3.281;

function landingFt(ev: number, la: number, sa: number): [number, number] {
  const v      = ev * MPH_TO_MS;
  const laRad  = la * (Math.PI / 180);
  const saRad  = sa * (Math.PI / 180);

  let rangeFt: number;
  if (la <= 0) {
    // Ground ball / line drive below horizontal
    const rollFactor = Math.max(0.05, 1 + la / 30);
    rangeFt = v * ROLL_K * rollFactor * M_TO_FT;
  } else {
    const rangeM = (v * v * Math.sin(2 * laRad) / G) * DRAG_K;
    rangeFt = rangeM * M_TO_FT;
  }

  const x =  rangeFt * Math.sin(saRad);
  const z = -rangeFt * Math.cos(saRad);   // SVG: outfield is −y
  return [x, z];
}

// ── EV colour mapping ─────────────────────────────────────────────────────────
// 60 mph → steel blue, 90 mph → gold, 110+ mph → red-orange
function evColor(ev: number): string {
  const t = Math.max(0, Math.min(1, (ev - 60) / 55));
  if (t < 0.5) {
    const u = t * 2;
    const r = Math.round(44  + u * (255 - 44));
    const g = Math.round(150 + u * (200 - 150));
    const b = Math.round(220 - u * 220);
    return `rgb(${r},${g},${b})`;
  }
  const u = (t - 0.5) * 2;
  const r = 255;
  const g = Math.round(200 - u * 170);
  const b = 0;
  return `rgb(${r},${g},${b})`;
}

// ── Field geometry (feet) ─────────────────────────────────────────────────────
// Field wall: 330 ft at foul lines (±45°), 400 ft at centre
function wallDist(angleDeg: number): number {
  return 330 + 70 * (1 - Math.abs(angleDeg) / 45);
}

function fieldArcPoints(innerOffset = 0): string {
  const pts: string[] = [];
  for (let deg = -45; deg <= 45; deg += 2) {
    const rad  = deg * (Math.PI / 180);
    const dist = wallDist(deg) - innerOffset;
    pts.push(`${(dist * Math.sin(rad)).toFixed(1)},${(-dist * Math.cos(rad)).toFixed(1)}`);
  }
  return pts.join(' ');
}

// Infield diamond corners
const FIRST  = [ 63.64, -63.64] as const;
const SECOND = [ 0,    -127.28] as const;
const THIRD  = [-63.64, -63.64] as const;
const HOME   = [ 0,      0    ] as const;

const DIAMOND = [HOME, FIRST, SECOND, THIRD]
  .map(([x, y]) => `${x},${y}`)
  .join(' ');

// Foul lines
const FOUL_R_END = `${(400 * Math.sin(45 * Math.PI / 180)).toFixed(1)},${(-400 * Math.cos(45 * Math.PI / 180)).toFixed(1)}`;
const FOUL_L_END = `${(-400 * Math.sin(45 * Math.PI / 180)).toFixed(1)},${(-400 * Math.cos(45 * Math.PI / 180)).toFixed(1)}`;

// ── Component ─────────────────────────────────────────────────────────────────
export function SprayChart(): React.ReactElement {
  const swings      = useSwings();
  const activeSwing = useActiveSwing();
  const setActive   = useStore((s) => s.setActiveSwing);

  const dots = swings
    .filter((sw) => !sw.ball.radarOnly)
    .map((sw) => {
      const [x, y] = landingFt(sw.ball.exitVelocity, sw.ball.launchAngle, sw.ball.sprayAngle);
      return { sw, x, y };
    });

  // Clamp dots to within the outfield wall
  const clampedDots = dots.map(({ sw, x, y }) => {
    const angleDeg = Math.atan2(-x, y) * (180 / Math.PI);   // spray angle
    const maxDist  = wallDist(angleDeg);
    const dist     = Math.sqrt(x * x + y * y);
    const scale    = dist > maxDist ? maxDist / dist : 1;
    return { sw, x: x * scale, y: y * scale, clipped: dist > maxDist };
  });

  const isGroundBall = (sw: SwingSession) => sw.ball.launchAngle <= 0;

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>SPRAY CHART</span>
        <span style={styles.sub}>{swings.length} swing{swings.length !== 1 ? 's' : ''}</span>
      </div>

      <svg
        viewBox="-310 -430 620 460"
        style={styles.svg}
        aria-label="Baseball field spray chart"
      >
        {/* ── Field ──────────────────────────────────────────────────── */}
        {/* Sky / foul territory */}
        <rect x="-310" y="-430" width="620" height="460" fill="#0a0a0f" />

        {/* Fair territory fill */}
        <polygon
          points={`0,0 ${FOUL_L_END} ${fieldArcPoints()} ${FOUL_R_END}`}
          fill="#0d1a0d"
        />

        {/* Warning track (20 ft inner band) */}
        <polygon
          points={`0,0 ${FOUL_L_END} ${fieldArcPoints()} ${FOUL_R_END}`}
          fill="none"
        />
        <polyline
          points={fieldArcPoints(0)}
          fill="none"
          stroke="#2a2010"
          strokeWidth="20"
        />

        {/* Outfield wall */}
        <polyline
          points={fieldArcPoints(0)}
          fill="none"
          stroke="#223322"
          strokeWidth="2"
        />

        {/* Foul lines */}
        <line x1="0" y1="0" x2={FOUL_R_END.split(',')[0]} y2={FOUL_R_END.split(',')[1]}
          stroke="#1a2a1a" strokeWidth="1" />
        <line x1="0" y1="0" x2={FOUL_L_END.split(',')[0]} y2={FOUL_L_END.split(',')[1]}
          stroke="#1a2a1a" strokeWidth="1" />

        {/* Infield dirt */}
        <polygon points={DIAMOND} fill="#1a1208" stroke="#221a08" strokeWidth="1" />

        {/* Pitcher's mound */}
        <circle cx="0" cy="-60.5" r="9" fill="#1e1508" stroke="#251c09" strokeWidth="1" />

        {/* Base paths */}
        <polyline
          points={`${HOME} ${FIRST[0]},${FIRST[1]} ${SECOND[0]},${SECOND[1]} ${THIRD[0]},${THIRD[1]} ${HOME}`}
          fill="none"
          stroke="#2a2010"
          strokeWidth="2"
        />

        {/* Bases */}
        {[FIRST, SECOND, THIRD].map(([bx, by], i) => (
          <rect
            key={i}
            x={bx - 4.5} y={by - 4.5}
            width="9" height="9"
            transform={`rotate(45,${bx},${by})`}
            fill="#2a2518"
            stroke="#3a3020"
            strokeWidth="1"
          />
        ))}

        {/* Home plate */}
        <polygon
          points="0,-8.5 6,-5 6,5 -6,5 -6,-5"
          fill="#2a2518"
          stroke="#3a3020"
          strokeWidth="1"
        />

        {/* Distance markers */}
        {[100, 200, 300, 400].map((ft) => (
          <g key={ft}>
            <text
              x="4" y={-ft + 5}
              fontSize="10"
              fill="#1e2a1e"
              fontFamily="inherit"
            >
              {ft}
            </text>
          </g>
        ))}

        {/* ── Swing dots ─────────────────────────────────────────────── */}
        {clampedDots.map(({ sw, x, y, clipped }) => {
          const active  = sw.id === activeSwing?.id;
          const color   = evColor(sw.ball.exitVelocity);
          const ground  = isGroundBall(sw);
          const r       = active ? 7 : 5;

          return (
            <g
              key={sw.id}
              style={{ cursor: 'pointer' }}
              onClick={() => setActive(sw.id)}
            >
              {/* Active ring */}
              {active && (
                <circle cx={x} cy={y} r={r + 5}
                  fill="none" stroke={color} strokeWidth="1" strokeOpacity={0.4} />
              )}

              {/* Wall-clip indicator */}
              {clipped && (
                <circle cx={x} cy={y} r={r + 3}
                  fill="none" stroke={color} strokeWidth="1" strokeDasharray="3,2" strokeOpacity={0.5} />
              )}

              {/* Dot — circle for fly/line, X for groundball */}
              {ground ? (
                <g>
                  <line x1={x - r} y1={y - r} x2={x + r} y2={y + r} stroke={color} strokeWidth="1.5" />
                  <line x1={x + r} y1={y - r} x2={x - r} y2={y + r} stroke={color} strokeWidth="1.5" />
                </g>
              ) : (
                <circle
                  cx={x} cy={y} r={r}
                  fill={active ? color : 'rgba(0,0,0,0.4)'}
                  stroke={color}
                  strokeWidth={active ? 1.5 : 1}
                />
              )}

              {/* EV label on active swing */}
              {active && (
                <text
                  x={x + 9} y={y + 4}
                  fontSize="11"
                  fill={color}
                  fontFamily="inherit"
                  fontWeight="700"
                >
                  {sw.ball.exitVelocity} mph
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div style={styles.legend}>
        <span style={styles.legendItem}>
          <svg width="12" height="12">
            <circle cx="6" cy="6" r="5" fill="none" stroke="#668" strokeWidth="1" />
          </svg>
          fly ball
        </span>
        <span style={styles.legendItem}>
          <svg width="12" height="12">
            <line x1="2" y1="2" x2="10" y2="10" stroke="#668" strokeWidth="1.5" />
            <line x1="10" y1="2" x2="2" y2="10" stroke="#668" strokeWidth="1.5" />
          </svg>
          ground ball
        </span>
        <span style={styles.legendItem}>
          <svg width="12" height="12">
            <circle cx="6" cy="6" r="4" fill="none" stroke="#668" strokeWidth="1" strokeDasharray="2,1.5" />
          </svg>
          wall (est.)
        </span>
        <span style={{ ...styles.legendItem, marginLeft: 'auto' }}>
          <EVColorBar />
          <span style={{ color: '#44aaff', marginLeft: 4 }}>60</span>
          <span style={{ color: '#c0c4cc', margin: '0 2px' }}>→</span>
          <span style={{ color: '#ff6600' }}>110+ mph</span>
        </span>
      </div>
    </div>
  );
}

function EVColorBar(): React.ReactElement {
  const steps = 20;
  return (
    <svg width="40" height="8" style={{ verticalAlign: 'middle' }}>
      {Array.from({ length: steps }, (_, i) => {
        const t   = i / (steps - 1);
        const ev  = 60 + t * 55;
        return (
          <rect
            key={i}
            x={i * (40 / steps)} y="0"
            width={40 / steps + 0.5} height="8"
            fill={evColor(ev)}
          />
        );
      })}
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    background: '#080810',
    border: '1px solid #1a1a2e',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '8px 12px 0',
  },
  title: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#d0d4dc',
  },
  sub: {
    fontSize: 9,
    color: '#e0e4ec',
  },
  svg: {
    display: 'block',
    width: '100%',
    fontFamily: "'JetBrains Mono','Fira Code',monospace",
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '4px 10px 6px',
    borderTop: '1px solid #111',
    fontSize: 9,
    color: '#d0d4dc',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
};
