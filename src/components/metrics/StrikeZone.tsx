import React from 'react';
import type { SwingSession } from '@/types/pipeline';

const M_TO_FT = 3.28084;

/**
 * Convert a session's swings to ZonePoints for the StrikeZone plot.
 * Pitching swings (ball.pitch populated) use the plate-crossing location;
 * hitting swings use the first detected 3-D trajectory point as a contact-
 * point proxy. The active swing is emphasised; the rest dim.
 */
export function buildZonePoints(
  swings: SwingSession[],
  active: SwingSession | null,
): ZonePoint[] {
  const pts: ZonePoint[] = [];
  for (const sw of swings) {
    let x: number | null = null;
    let y: number | null = null;
    let label: string | undefined;
    if (sw.ball.pitch) {
      x = sw.ball.pitch.plateLocXFt;
      y = sw.ball.pitch.plateLocYFt;
      label = `${sw.ball.pitch.releaseSpeedMph.toFixed(1)} mph`;
    } else if (sw.ball.trajectory.length > 0) {
      const p0 = sw.ball.trajectory[0];
      x = p0.x * M_TO_FT;
      y = p0.y * M_TO_FT;
      label = `${sw.ball.exitVelocity.toFixed(1)} mph`;
    }
    if (x == null || y == null) continue;
    pts.push({ x, y, label, active: sw.id === active?.id });
  }
  return pts;
}

/**
 * Strike-zone plot — catcher's view (looking out toward the pitcher).
 *
 * Drives a single SVG that works for both modes by accepting a list of
 * (x, y) locations in feet relative to the centre of home plate:
 *   +X  → first-base side  (right of plate in catcher's view, so drawn LEFT)
 *   +Y  → height off the ground
 *
 * For pitching sessions the locations are where each pitch crossed the
 * front of the plate. For hitting sessions they're the contact point of
 * each swing (the first detected 3-D point of the batted-ball trajectory).
 */

export interface ZonePoint {
  x: number;          // feet, +1B side
  y: number;          // feet, height above ground
  active?: boolean;   // emphasised marker for the most recent / selected
  label?: string;     // small badge text (e.g. mph, pitch type)
}

interface Props {
  points: ZonePoint[];
  /** Header text — defaults to "STRIKE ZONE" */
  title?: string;
  /** Top/bottom of the strike zone in feet. Defaults to a generic adult
   *  (top of zone ≈ midpoint between shoulders and pant top, bottom ≈ bottom
   *  of the kneecap). */
  zoneTopFt?:    number;
  zoneBottomFt?: number;
}

// Plate is 17" wide; strike zone is the same width (the plate sets it).
const ZONE_W_FT = 17 / 12;

export function StrikeZone({
  points,
  title         = 'STRIKE ZONE',
  zoneTopFt     = 3.5,
  zoneBottomFt  = 1.5,
}: Props): React.ReactElement {
  const VIEW_W   = 260;
  const VIEW_H   = 300;
  // 1 ft = SCALE px — sized to leave generous padding around the zone.
  const SCALE    = 80;
  const cx       = VIEW_W / 2;
  const groundY  = VIEW_H - 32;   // ground line near bottom

  const ftToPx = (xFt: number, yFt: number) => ({
    // Catcher's view: +X (1B side) appears on the LEFT, so we invert X.
    px: cx - xFt * SCALE,
    py: groundY - yFt * SCALE,
  });

  const sz = {
    left:   cx - (ZONE_W_FT / 2) * SCALE,
    right:  cx + (ZONE_W_FT / 2) * SCALE,
    top:    groundY - zoneTopFt    * SCALE,
    bottom: groundY - zoneBottomFt * SCALE,
  };
  const zoneW = sz.right - sz.left;
  const zoneH = sz.bottom - sz.top;

  const isInZone = (p: ZonePoint) =>
    Math.abs(p.x) <= ZONE_W_FT / 2 && p.y >= zoneBottomFt && p.y <= zoneTopFt;

  return (
    <div style={s.card}>
      <div style={s.cardTitle}>{title}</div>
      <svg width={VIEW_W} height={VIEW_H} style={{ display: 'block' }}>
        {/* Ground line */}
        <line x1={20} y1={groundY} x2={VIEW_W - 20} y2={groundY}
              stroke="#1a3a40" strokeWidth={1} />

        {/* 3×3 grid (inside the zone) */}
        {[1, 2].map((i) => (
          <line key={`v${i}`}
            x1={sz.left + (zoneW * i) / 3} y1={sz.top}
            x2={sz.left + (zoneW * i) / 3} y2={sz.bottom}
            stroke="#222a3a" strokeDasharray="2 4" strokeWidth={1} />
        ))}
        {[1, 2].map((i) => (
          <line key={`h${i}`}
            x1={sz.left}  y1={sz.top + (zoneH * i) / 3}
            x2={sz.right} y2={sz.top + (zoneH * i) / 3}
            stroke="#222a3a" strokeDasharray="2 4" strokeWidth={1} />
        ))}

        {/* Strike-zone box on top of the grid */}
        <rect x={sz.left} y={sz.top} width={zoneW} height={zoneH}
              fill="none" stroke="#88aacc" strokeWidth={2} />

        {/* Home plate (pentagon, top-down silhouette at the ground line) */}
        <polygon
          points={[
            `${sz.left  - 6},${groundY - 4}`,
            `${sz.right + 6},${groundY - 4}`,
            `${sz.right + 6},${groundY + 4}`,
            `${cx},${groundY + 12}`,
            `${sz.left  - 6},${groundY + 4}`,
          ].join(' ')}
          fill="#0d0d18" stroke="#445" strokeWidth={1.5}
        />

        {/* Pitch / contact dots */}
        {points.map((p, i) => {
          const { px, py } = ftToPx(p.x, p.y);
          const inZone = isInZone(p);
          return (
            <g key={i}>
              <circle cx={px} cy={py}
                      r={p.active ? 9 : 5}
                      fill={inZone ? '#44ff88' : '#ff4455'}
                      stroke={p.active ? '#000' : 'none'}
                      strokeWidth={p.active ? 2 : 0}
                      opacity={p.active ? 1 : 0.55} />
              {p.label && p.active && (
                <text x={px} y={py - 14} textAnchor="middle"
                      fontSize={9} fill="#cde" fontWeight={700}>
                  {p.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Axis hints */}
        <text x={20}        y={groundY + 22} fontSize={8} fill="#445">3B side</text>
        <text x={VIEW_W-20} y={groundY + 22} fontSize={8} fill="#445" textAnchor="end">1B side</text>
      </svg>

      {/* Legend */}
      <div style={s.legend}>
        <span style={{ ...s.swatch, background: '#44ff88' }} /> in zone
        <span style={{ ...s.swatch, background: '#ff4455', marginLeft: 14 }} /> out of zone
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  card: {
    background: '#0d0d18',
    border: '1px solid #1a1a2e',
    borderRadius: 8,
    padding: '12px 14px',
    display: 'inline-flex',
    flexDirection: 'column',
    gap: 8,
  },
  cardTitle: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.14em',
    color: '#776633',
  },
  legend: {
    fontSize: 9,
    color: '#c0c4cc',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    letterSpacing: '0.05em',
  },
  swatch: {
    display: 'inline-block',
    width: 8, height: 8, borderRadius: '50%',
    marginRight: 4,
  },
};
