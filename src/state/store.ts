import { create } from 'zustand';
import { createCalibrationSlice, type CalibrationSlice } from './calibration.slice';
import { createSessionSlice, type SessionSlice } from './session.slice';
import { createSessionModeSlice, type SessionModeSlice } from './session-mode.slice';
import { createMetricsSlice, type MetricsSlice } from './metrics.slice';
import { createUISlice, type UISlice } from './ui.slice';
import { createSettingsSlice, type SettingsSlice } from './settings.slice';
import { createDrillSessionSlice, type DrillSessionSlice } from './drill-session.slice';

export type OVLMStore = CalibrationSlice & SessionSlice & SessionModeSlice
                      & MetricsSlice & UISlice & SettingsSlice & DrillSessionSlice;

export const useStore = create<OVLMStore>()((...args) => ({
  ...createCalibrationSlice(...args),
  ...createSessionSlice(...args),
  ...createSessionModeSlice(...args),
  ...createMetricsSlice(...args),
  ...createUISlice(...args),
  ...createSettingsSlice(...args),
  ...createDrillSessionSlice(...args),
}));

// Expose the live store on `window` in dev so end-to-end tests and the
// browser devtools can drive state without going through React. Tree-shaken
// in production builds (import.meta.env.PROD).
if (import.meta.env && !import.meta.env.PROD && typeof window !== 'undefined') {
  (window as any).__OVLM_STORE__ = useStore;
}

// Typed selectors for common access patterns
export const useCalibration = () => useStore((s) => s.calibrationData);
export const useCalibrationState = () => useStore((s) => s.calibrationState);
export const usePipelineStatus = () => useStore((s) => s.pipelineStatus);
export const useCalibrationProgress = () => useStore((s) => s.calibrationProgress);
export const useWsHost = () => useStore((s) => s.wsHost);

/** Returns the explicitly selected swing, or the most recent swing as a
 *  fallback — never null just because nothing was clicked. */
export const useActiveSwing = () =>
  useStore((s) => {
    const sel = s.activeSwingId
      ? s.swings.find((sw) => sw.id === s.activeSwingId)
      : undefined;
    return sel ?? s.swings[0] ?? null;
  });

/** Most recent HIT (ball.pitch == null). If the user selected a hit swing
 *  explicitly, that one takes priority; otherwise always the latest hit. */
export const useLatestHitSwing = () =>
  useStore((s) => {
    if (s.activeSwingId) {
      const sel = s.swings.find((sw) => sw.id === s.activeSwingId);
      if (sel && sel.ball.pitch == null) return sel;
    }
    return s.swings.find((sw) => sw.ball.pitch == null) ?? null;
  });

/** Most recent PITCH (ball.pitch != null). If the user selected a pitch swing
 *  explicitly, that one takes priority; otherwise always the latest pitch. */
export const useLatestPitchSwing = () =>
  useStore((s) => {
    if (s.activeSwingId) {
      const sel = s.swings.find((sw) => sw.id === s.activeSwingId);
      if (sel && sel.ball.pitch != null) return sel;
    }
    return s.swings.find((sw) => sw.ball.pitch != null) ?? null;
  });

export const useSwings = () => useStore((s) => s.swings);
export const useUIPanel = () => useStore((s) => s.activePanel);
export const useOverlays = () => useStore((s) => s.overlaysEnabled);
export const useSelectedStadium = () => useStore((s) => s.selectedStadiumId);
export const useCameraPreset = () => useStore((s) => s.cameraPreset);
