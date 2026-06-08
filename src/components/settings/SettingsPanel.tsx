import React from 'react';
import { useStore } from '@/state/store';
import { piClient } from '@/ws/client';

const MPH_TO_KPH = 1.60934;

export function SettingsPanel(): React.ReactElement {
  const settings       = useStore((s) => s.settings);
  const update         = useStore((s) => s.updateSettings);
  const reset          = useStore((s) => s.resetSettings);
  const wsHost         = useStore((s) => s.wsHost);
  const setWsHost      = useStore((s) => s.setWsHost);
  const allTimeBest    = useStore((s) => s.allTimeBestEv);
  const clearRecord    = useStore((s) => s.clearNewRecord);

  const [hostDraft, setHostDraft] = React.useState(wsHost);

  const applyHost = () => {
    const url = hostDraft.trim();
    if (!url) return;
    setWsHost(url);
    piClient.disconnect();
  };

  const wipeRecord = () => {
    localStorage.removeItem('ovlm_all_time_ev');
    clearRecord();
    // Force store reset by updating to 0 via a direct localStorage wipe;
    // page reload picks it up automatically — tell user to reload or just reset.
    update({});   // trigger re-render; allTimeBestEv only resets on next load
    window.location.reload();
  };

  return (
    <div style={styles.root}>
      <div style={styles.title}>SETTINGS</div>

      {/* ── Pi connection ─────────────────────────────────────────── */}
      <Section label="PI CONNECTION">
        <Row label="WebSocket URL">
          <div style={styles.inputRow}>
            <input
              style={styles.input}
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyHost()}
              placeholder="ws://ovlm.local:8765"
              spellCheck={false}
            />
            <button style={styles.btnSmall} onClick={applyHost}>APPLY</button>
          </div>
        </Row>
      </Section>

      {/* ── Display units ─────────────────────────────────────────── */}
      <Section label="DISPLAY">
        <Row label="Exit velocity unit">
          <ToggleGroup
            options={[
              { value: 'mph', label: 'mph' },
              { value: 'kph', label: 'kph' },
            ]}
            value={settings.evUnit}
            onChange={(v) => update({ evUnit: v as 'mph' | 'kph' })}
          />
        </Row>
        {settings.evUnit === 'kph' && allTimeBest > 0 && (
          <div style={styles.hint}>
            All-time record: {(allTimeBest * MPH_TO_KPH).toFixed(1)} kph
            ({allTimeBest} mph stored)
          </div>
        )}
      </Section>

      {/* ── Swing thresholds ──────────────────────────────────────── */}
      <Section label="THRESHOLDS">
        <Row label={`Streak threshold (${settings.evUnit})`}>
          <div style={styles.inputRow}>
            <input
              type="number"
              style={{ ...styles.input, width: 80 }}
              value={
                settings.evUnit === 'kph'
                  ? Math.round(settings.streakThreshold * MPH_TO_KPH)
                  : settings.streakThreshold
              }
              min={settings.evUnit === 'kph' ? 100 : 60}
              max={settings.evUnit === 'kph' ? 200 : 120}
              step={settings.evUnit === 'kph' ? 5 : 5}
              onChange={(e) => {
                const raw = parseFloat(e.target.value);
                const mph = settings.evUnit === 'kph' ? raw / MPH_TO_KPH : raw;
                update({ streakThreshold: Math.round(mph) });
              }}
            />
            <span style={styles.unit}>{settings.evUnit}</span>
          </div>
          <div style={styles.hint}>
            Consecutive swings at or above this value show the streak counter.
          </div>
        </Row>

        <Row label="Optimal launch angle range">
          <div style={styles.inputRow}>
            <input
              type="number" style={{ ...styles.input, width: 60 }}
              value={settings.laOptimalMin} min={-10} max={30} step={1}
              onChange={(e) => update({ laOptimalMin: parseInt(e.target.value, 10) })}
            />
            <span style={styles.unit}>°</span>
            <span style={{ ...styles.unit, marginLeft: 4 }}>to</span>
            <input
              type="number" style={{ ...styles.input, width: 60 }}
              value={settings.laOptimalMax} min={10} max={50} step={1}
              onChange={(e) => update({ laOptimalMax: parseInt(e.target.value, 10) })}
            />
            <span style={styles.unit}>°</span>
          </div>
          <div style={styles.hint}>
            Swings within this range show "Optimal range" in the metrics detail.
          </div>
        </Row>
      </Section>

      {/* ── Records ───────────────────────────────────────────────── */}
      <Section label="RECORDS">
        <Row label="All-time best EV">
          <div style={styles.inputRow}>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#ff6644', fontVariantNumeric: 'tabular-nums' }}>
              {allTimeBest > 0
                ? settings.evUnit === 'kph'
                  ? `${(allTimeBest * MPH_TO_KPH).toFixed(1)} kph`
                  : `${allTimeBest} mph`
                : '—'}
            </span>
            {allTimeBest > 0 && (
              <button style={styles.btnDanger} onClick={wipeRecord}>RESET</button>
            )}
          </div>
        </Row>
      </Section>

      {/* ── Danger zone ───────────────────────────────────────────── */}
      <Section label="DANGER ZONE">
        <Row label="Reset all settings to defaults">
          <button style={styles.btnDanger} onClick={reset}>RESET DEFAULTS</button>
        </Row>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>{label}</div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.row}>
      <div style={styles.rowLabel}>{label}</div>
      <div style={styles.rowControl}>{children}</div>
    </div>
  );
}

function ToggleGroup({ options, value, onChange }: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={styles.toggleGroup}>
      {options.map((opt) => (
        <button
          key={opt.value}
          style={{
            ...styles.toggleBtn,
            ...(opt.value === value ? styles.toggleBtnActive : {}),
          }}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    maxWidth: 560,
    margin: '0 auto',
    padding: '28px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
  },
  title: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.2em',
    color: '#445',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    border: '1px solid #1a1a2e',
    borderRadius: 8,
    overflow: 'hidden',
  },
  sectionLabel: {
    padding: '8px 16px',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#445',
    background: '#0d0d14',
    borderBottom: '1px solid #1a1a2e',
  },
  sectionBody: {
    background: '#0a0a12',
    display: 'flex',
    flexDirection: 'column',
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 16,
    padding: '14px 16px',
    borderBottom: '1px solid #0d0d18',
  },
  rowLabel: {
    fontSize: 11,
    color: '#99aabb',
    width: 200,
    flexShrink: 0,
    paddingTop: 2,
  },
  rowControl: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    background: '#07070f',
    border: '1px solid #1a1a2e',
    borderRadius: 4,
    color: '#aabbcc',
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '5px 10px',
    outline: 'none',
  },
  unit: {
    fontSize: 10,
    color: '#445',
  },
  hint: {
    fontSize: 9,
    color: '#334',
    lineHeight: 1.5,
  },
  toggleGroup: {
    display: 'flex',
    border: '1px solid #1a1a2e',
    borderRadius: 4,
    overflow: 'hidden',
    width: 'fit-content',
  },
  toggleBtn: {
    padding: '5px 16px',
    background: 'transparent',
    border: 'none',
    borderRight: '1px solid #1a1a2e',
    color: '#445',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
  },
  toggleBtnActive: {
    background: '#131326',
    color: '#4488ff',
  },
  btnSmall: {
    padding: '5px 12px',
    background: '#0d0d14',
    border: '1px solid #1a1a2e',
    borderRadius: 4,
    color: '#667788',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
    flexShrink: 0,
  },
  btnDanger: {
    padding: '5px 12px',
    background: '#1a0010',
    border: '1px solid #441020',
    borderRadius: 4,
    color: '#ff6688',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    fontFamily: 'inherit',
    flexShrink: 0,
  },
};
