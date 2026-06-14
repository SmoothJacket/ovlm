import React from 'react';
import { useStore, useUIPanel } from '@/state/store';
import { StatusBar } from './StatusBar';
import { CalibrationWizard } from '../calibration/CalibrationWizard';
import { DualVideoPanel } from '../capture/DualVideoPanel';
import { MetricsDashboard } from '../metrics/MetricsDashboard';
import { SimulatorFrame } from '../visualization/SimulatorFrame';
import { SettingsPanel } from '../settings/SettingsPanel';

const NAV_ITEMS = [
  { id: 'capture',       label: 'CAPTURE',       icon: '⬤' },
  { id: 'calibration',   label: 'CALIBRATE',      icon: '⊞' },
  { id: 'metrics',       label: 'METRICS',        icon: '▦' },
  { id: 'visualization', label: '3D VIEW',        icon: '◎' },
] as const;

export function Dashboard(): React.ReactElement {
  const activePanel = useUIPanel();
  const setPanel = useStore((s) => s.setPanel);

  return (
    <div style={styles.root}>
      {/* Left nav rail */}
      <nav style={styles.nav}>
        <div style={styles.logo}>
          <span style={styles.logoMark}>⚾</span>
          <span style={styles.logoText}>OVLM</span>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            style={{
              ...styles.navBtn,
              ...(activePanel === item.id ? styles.navBtnActive : {}),
            }}
            onClick={() => setPanel(item.id)}
            title={item.label}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            <span style={styles.navLabel}>{item.label}</span>
          </button>
        ))}

        {/* Settings pinned to bottom */}
        <div style={{ marginTop: 'auto' }}>
          <button
            style={{
              ...styles.navBtn,
              ...(activePanel === 'settings' ? styles.navBtnActive : {}),
            }}
            onClick={() => setPanel('settings')}
            title="SETTINGS"
          >
            <span style={styles.navIcon}>⚙</span>
            <span style={styles.navLabel}>SETTINGS</span>
          </button>
        </div>
      </nav>

      {/* Main content area */}
      <main style={styles.main}>
        <StatusBar />
        <div style={styles.content}>
          {activePanel === 'capture'       && <DualVideoPanel />}
          {activePanel === 'calibration'   && <CalibrationWizard />}
          {activePanel === 'metrics'       && <MetricsDashboard />}
          {activePanel === 'settings'      && <SettingsPanel />}

          {/* 3D VIEW is the live-driven HitTrax stadium simulator. Mounted at
              Dashboard level (not inside the panel conditional) so it survives
              panel switches — the sim preloads 30 stadiums. */}
          <SimulatorFrame visible={activePanel === 'visualization'} />
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
    background: '#0a0a0f',
    color: '#e0e0e8',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  nav: {
    width: 72,
    minWidth: 72,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    background: '#0d0d14',
    borderRight: '1px solid #1a1a2e',
    paddingTop: 12,
    gap: 4,
  },
  logo: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    marginBottom: 16,
    padding: '8px 0',
  },
  logoMark: { fontSize: 24 },
  logoText: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#4488ff',
    marginTop: 2,
  },
  navBtn: {
    width: 60,
    padding: '10px 4px',
    background: 'transparent',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    color: '#667',
    transition: 'all 0.15s',
  },
  navBtnActive: {
    background: '#131326',
    color: '#4488ff',
    boxShadow: 'inset 0 0 0 1px #1a2a5e',
  },
  navIcon: { fontSize: 18 },
  navLabel: { fontSize: 8, letterSpacing: '0.08em', fontWeight: 600 },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
};
