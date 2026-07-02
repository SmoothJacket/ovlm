import React, { useEffect, useRef, useState } from 'react';
import { useStore, useSwings, useActiveSwing } from '@/state/store';
import type { SwingSession } from '@/types/pipeline';

const MPH_TO_KPH = 1.60934;

function currentStreak(swings: SwingSession[], threshold: number): number {
  let count = 0;
  for (const sw of swings) {   // swings[0] is newest
    if (sw.ball.exitVelocity >= threshold) count++;
    else break;
  }
  return count;
}

function fmtEv(ev: number, unit: 'mph' | 'kph'): string {
  return unit === 'kph' ? (ev * MPH_TO_KPH).toFixed(1) : String(ev);
}

const PAD   = { top: 18, right: 20, bottom: 28, left: 42 };
const H     = 160;
const ROLL  = 3;   // rolling-average window

// Reference lines shown on the chart
const REFS = [
  { ev: 80,  label: '80',  color: '#1e2a1e' },
  { ev: 90,  label: '90',  color: '#1a2830', labelColor: '#e0e4ec' },
  { ev: 100, label: '100', color: '#1e2020', labelColor: '#e0e4ec' },
  { ev: 110, label: '110', color: '#221a10', labelColor: '#d0d4dc' },
];

function rollingAvg(evs: number[], i: number): number {
  const slice = evs.slice(Math.max(0, i - ROLL + 1), i + 1);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function trend(evs: number[]): { dir: 'up' | 'down' | 'flat'; delta: number } {
  if (evs.length < 4) return { dir: 'flat', delta: 0 };
  const half  = Math.max(1, Math.floor(evs.length / 2));
  const early = evs.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const late  = evs.slice(-half).reduce((a, b) => a + b, 0) / half;
  const delta = late - early;
  return { dir: delta > 1 ? 'up' : delta < -1 ? 'down' : 'flat', delta };
}

export function EVChart(): React.ReactElement {
  const swings          = useSwings();
  const activeSwing     = useActiveSwing();
  const setActive       = useStore((s) => s.setActiveSwing);
  const allTimeBest     = useStore((s) => s.allTimeBestEv);
  const newRecordId     = useStore((s) => s.newRecordSwingId);
  const clearNewRecord  = useStore((s) => s.clearNewRecord);
  const settings        = useStore((s) => s.settings);
  const { evUnit, streakThreshold } = settings;

  const svgRef  = useRef<SVGSVGElement>(null);
  const [plotW, setPlotW] = useState(600);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setPlotW(Math.max(60, w - PAD.left - PAD.right));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Oldest first so the chart reads left → right over session time
  const sorted: SwingSession[] = [...swings].reverse();
  const evs = sorted.map((s) => s.ball.exitVelocity);
  const n   = sorted.length;

  // Y domain — round to nearest 5, ensure at least 20 mph range
  const rawMin = Math.min(...evs);
  const rawMax = Math.max(...evs);
  const yMin = Math.max(50,  Math.floor((rawMin - 5) / 5) * 5);
  const yMax = Math.min(135, Math.ceil((rawMax  + 5) / 5) * 5);
  const yRange = Math.max(20, yMax - yMin);

  const plotH = H - PAD.top - PAD.bottom;

  const xOf = (i: number) =>
    PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);

  const yOf = (ev: number) =>
    PAD.top + plotH - ((ev - yMin) / yRange) * plotH;

  const mainPts  = sorted.map((sw, i) => `${xOf(i)},${yOf(sw.ball.exitVelocity)}`).join(' ');
  const rollPts  = evs.map((_, i) => `${xOf(i)},${yOf(rollingAvg(evs, i))}`).join(' ');

  // Y-axis ticks every 10 mph
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / 10) * 10; v <= yMax; v += 10) yTicks.push(v);

  // Session stats
  const avg  = evs.reduce((a, b) => a + b, 0) / evs.length;
  const max  = Math.max(...evs);
  const trnd = trend(evs);

  const trendLabel =
    trnd.dir === 'up'   ? `↑ +${trnd.delta.toFixed(1)}` :
    trnd.dir === 'down' ? `↓ ${trnd.delta.toFixed(1)}`  : '→ flat';
  const trendColor =
    trnd.dir === 'up' ? '#44ff88' : trnd.dir === 'down' ? '#ff4455' : '#c0c4cc';

  const streak = currentStreak(swings, streakThreshold);

  useEffect(() => {
    if (!newRecordId) return;
    const t = setTimeout(clearNewRecord, 3000);
    return () => clearTimeout(t);
  }, [newRecordId, clearNewRecord]);

  return (
    <div style={styles.wrap}>
      {/* Stats strip */}
      <div style={styles.statsRow}>
        <Stat label="AVG EV"  value={fmtEv(avg, evUnit)}  unit={evUnit} />
        <Stat label="MAX EV"  value={fmtEv(max, evUnit)}  unit={evUnit} color="#ff6644" />
        <Stat label="SWINGS"  value={`${n}`}               unit="" />
        <div style={styles.statBox}>
          <div style={styles.statLabel}>TREND</div>
          <div style={{ ...styles.statValue, color: trendColor }}>{trendLabel}</div>
        </div>

        {/* All-time record — key changes on new record so animation replays */}
        {allTimeBest > 0 && (
          <div
            key={newRecordId ?? 'atr'}
            style={{
              ...styles.statBox,
              border: '1px solid #111',
              borderRadius: 4,
              position: 'relative',
              animation: newRecordId ? 'record-flash 3s ease-out forwards' : 'none',
            }}
          >
            <div style={{ ...styles.statLabel, color: newRecordId ? '#ff6644' : '#e0e4ec' }}>
              {newRecordId ? 'NEW RECORD' : 'ALL-TIME'}
            </div>
            <div style={{ ...styles.statValue, color: newRecordId ? '#ff6644' : '#c0c4cc' }}>
              {fmtEv(allTimeBest, evUnit)}<span style={styles.statUnit}> {evUnit}</span>
            </div>
          </div>
        )}

        {/* Streak badge — only shown when 3+ consecutive swings above threshold */}
        {streak >= 3 && (
          <div style={{ ...styles.statBox, borderLeft: '2px solid #ff6644' }}>
            <div style={{ ...styles.statLabel, color: '#ff6644' }}>STREAK</div>
            <div style={{ ...styles.statValue, color: '#ff6644' }}>
              {streak}<span style={styles.statUnit}> x {evUnit === 'kph' ? Math.round(streakThreshold * MPH_TO_KPH) : streakThreshold}+</span>
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      <svg ref={svgRef} style={styles.svg} height={H}>
        {/* Reference bands */}
        {REFS.filter((r) => r.ev >= yMin && r.ev <= yMax).map((r) => (
          <g key={r.ev}>
            <line
              x1={PAD.left} x2={PAD.left + plotW}
              y1={yOf(r.ev)} y2={yOf(r.ev)}
              stroke={r.color} strokeWidth={14}
            />
            <line
              x1={PAD.left} x2={PAD.left + plotW}
              y1={yOf(r.ev)} y2={yOf(r.ev)}
              stroke={r.labelColor ?? '#e8ecf4'} strokeWidth={0.5} strokeDasharray="3,4"
            />
            <text
              x={PAD.left - 6} y={yOf(r.ev) + 4}
              textAnchor="end" fontSize={9}
              fill={r.labelColor ?? '#e0e4ec'}
            >
              {r.label}
            </text>
          </g>
        ))}

        {/* Y-axis ticks */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left - 4} x2={PAD.left}
              y1={yOf(v)} y2={yOf(v)}
              stroke="#223" strokeWidth={1}
            />
            <text x={PAD.left - 6} y={yOf(v) + 4} textAnchor="end" fontSize={9} fill="#334">
              {v}
            </text>
          </g>
        ))}

        {/* Y axis rule */}
        <line
          x1={PAD.left} x2={PAD.left}
          y1={PAD.top} y2={PAD.top + plotH}
          stroke="#1a1a2e" strokeWidth={1}
        />

        {/* Rolling average */}
        {n >= 2 && (
          <polyline
            points={rollPts}
            fill="none"
            stroke="#ff6644"
            strokeWidth={1}
            strokeDasharray="4,3"
            strokeOpacity={0.35}
          />
        )}

        {/* Main EV line */}
        {n >= 2 && (
          <polyline
            points={mainPts}
            fill="none"
            stroke="#ff6644"
            strokeWidth={1.5}
            strokeOpacity={0.7}
          />
        )}

        {/* Dots */}
        {sorted.map((sw, i) => {
          const cx = xOf(i);
          const cy = yOf(sw.ball.exitVelocity);
          const active = sw.id === activeSwing?.id;
          return (
            <g key={sw.id} style={{ cursor: 'pointer' }} onClick={() => setActive(sw.id)}>
              {active && (
                <circle cx={cx} cy={cy} r={8} fill="none" stroke="#ff6644" strokeWidth={1} strokeOpacity={0.4} />
              )}
              <circle
                cx={cx} cy={cy} r={active ? 5 : 3.5}
                fill={active ? '#ff6644' : '#1a0a04'}
                stroke="#ff6644"
                strokeWidth={active ? 1.5 : 1}
              />
              {/* Swing index label for first, last, and active */}
              {(i === 0 || i === n - 1 || active) && (
                <text
                  x={cx} y={cy - 9}
                  textAnchor="middle" fontSize={8} fill="#ff6644" fillOpacity={0.7}
                >
                  {sw.ball.exitVelocity}
                </text>
              )}
            </g>
          );
        })}

        {/* X axis label */}
        <text
          x={PAD.left + plotW / 2} y={H - 4}
          textAnchor="middle" fontSize={8} fill="#334" letterSpacing="0.1em"
        >
          SWING (oldest → newest)
        </text>
      </svg>
    </div>
  );
}

function Stat({
  label, value, unit, color = '#888888',
}: { label: string; value: string; unit: string; color?: string }) {
  return (
    <div style={styles.statBox}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color }}>
        {value}
        {unit && <span style={styles.statUnit}> {unit}</span>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    background: '#0a0a12',
    borderBottom: '1px solid #1a1a2e',
    flexShrink: 0,
  },
  statsRow: {
    display: 'flex',
    gap: 0,
    borderBottom: '1px solid #111',
  },
  statBox: {
    padding: '6px 14px',
    borderRight: '1px solid #111',
  },
  statLabel: {
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: '0.12em',
    color: '#e0e4ec',
    marginBottom: 1,
  },
  statValue: {
    fontSize: 15,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    color: '#888888',
  },
  statUnit: {
    fontSize: 9,
    opacity: 0.6,
  },
  svg: {
    display: 'block',
    width: '100%',
    overflow: 'visible',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
};
