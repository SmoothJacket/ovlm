import React, { useEffect } from 'react';
import { Dashboard } from './components/layout/Dashboard';
import { useStore } from './state/store';
import { piClient } from './ws/client';
import { initSimulatorBridge } from './integrations/simulator';

export function App(): React.ReactElement {
  const wsHost              = useStore((s) => s.wsHost);
  const updatePipeline      = useStore((s) => s.updatePipelineStatus);
  const ingestMeasurement   = useStore((s) => s.ingestPiMeasurement);
  const updatePiHealth      = useStore((s) => s.updatePiHealth);
  const setLastFrame        = useStore((s) => s.setLastFrame);
  const updateCalibrationProgress = useStore((s) => s.updateCalibrationProgress);
  const markModeCalibrated  = useStore((s) => s.markModeCalibrated);
  const updateRadarStatus   = useStore((s) => s.updateRadarStatus);

  useEffect(() => {
    piClient.connect(wsHost, {
      updatePipelineStatus: updatePipeline as (p: Record<string, unknown>) => void,
      ingestPiMeasurement:  ingestMeasurement,
      updatePiHealth,
      setLastFrame,
      updateCalibrationProgress,
      markModeCalibrated,
      updateRadarStatus,
    });
    return () => piClient.disconnect();
  }, [wsHost]);

  useEffect(() => {
    initSimulatorBridge(); // ready-handshake + auto-forward swings to the sim
  }, []);

  return (
    <>
      <style>{globalStyles}</style>
      <Dashboard />
    </>
  );
}

const globalStyles = `
  /* Light theme via global invert: flips the dark palette to a light one
     in one shot. Camera feeds, the 3-D simulator iframe, and any embedded
     images / canvases / videos get the inverse filter so their pixels stay
     correct (otherwise we'd be looking at colour-negative camera frames). */
  html, body { background: #ffffff; }
  html { filter: invert(1) hue-rotate(180deg); -webkit-filter: invert(1) hue-rotate(180deg); }
  img, video, canvas, iframe, picture, svg image {
    filter: invert(1) hue-rotate(180deg);
    -webkit-filter: invert(1) hue-rotate(180deg);
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  @keyframes record-flash {
    0%   { box-shadow: 0 0 0 2px #ff6644, 0 0 18px #ff6644; border-color: #ff6644; color: #ff6644; }
    60%  { box-shadow: 0 0 0 1px #ff6644, 0 0 8px #ff6644;  border-color: #ff6644; color: #ff6644; }
    100% { box-shadow: none; border-color: #111; color: inherit; }
  }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #080810; }
  ::-webkit-scrollbar-thumb { background: #1a1a2e; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #2a2a4e; }

  button:hover { filter: brightness(1.15); }
  button:active { filter: brightness(0.9); }
`;
