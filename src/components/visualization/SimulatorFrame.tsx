import React, { useEffect, useRef, useState } from 'react';
import { useActiveSwing } from '@/state/store';
import {
  getSimulatorUrl, registerEmbed, sendSwingToEmbed,
} from '@/integrations/simulator';

/**
 * Embedded HitTrax stadium simulator, driven live by the launch monitor.
 *
 * Mounted once at the Dashboard level and toggled with CSS (`visible`) so the
 * iframe survives panel switches — the sim preloads all 30 stadium models
 * (~20 s) and remounting would restart that every time.
 *
 * New swings from the WebSocket pipeline are auto-forwarded by the bridge in
 * integrations/simulator.ts; this component only registers the iframe window
 * and offers a manual replay of the selected swing.
 */
export function SimulatorFrame({ visible }: { visible: boolean }): React.ReactElement | null {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const activeSwing = useActiveSwing();

  // Lazy-mount: don't load the heavy sim until the user first opens this view.
  useEffect(() => {
    if (visible && !mounted) setMounted(true);
  }, [visible, mounted]);

  useEffect(() => () => registerEmbed(null), []);

  if (!mounted) return null;

  return (
    <div style={{ ...styles.root, display: visible ? 'block' : 'none' }}>
      <iframe
        ref={iframeRef}
        src={getSimulatorUrl()}
        style={styles.frame}
        title="HitTrax Stadium Simulator"
        allow="fullscreen"
        onLoad={() => registerEmbed(iframeRef.current?.contentWindow ?? null)}
      />
      {activeSwing && visible && (
        <button
          style={styles.replayBtn}
          title="Replay the swing selected in Metrics"
          onClick={() => sendSwingToEmbed(activeSwing.ball)}
        >
          ⚾ REPLAY {activeSwing.ball.exitVelocity.toFixed(1)} mph / {activeSwing.ball.launchAngle.toFixed(0)}°
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'absolute',
    inset: 0,
    background: '#060810',
  },
  frame: {
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
  },
  replayBtn: {
    position: 'absolute',
    bottom: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '6px 16px',
    background: 'rgba(10,10,20,0.85)',
    color: '#cc8844',
    border: '1px solid #2a1f10',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
};
