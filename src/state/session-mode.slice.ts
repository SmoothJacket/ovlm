import type { StateCreator } from 'zustand';

export type CalibrationMode = 'hitting' | 'pitching';

export type HittingSessionType  = 'free_hit' | 'hr_derby' | 'strike_zone' | 'game';
export type PitchingSessionType = 'low_intent_bullpen' | 'high_intent_bullpen' | 'live_pitching';
export type SessionType = HittingSessionType | PitchingSessionType;

export interface ActiveSession {
  mode: CalibrationMode;
  type: SessionType;
  startedAt: number;
}

const STORAGE_KEY_HIT  = 'ovlm_calibrated_hitting';
const STORAGE_KEY_PIT  = 'ovlm_calibrated_pitching';
const STORAGE_KEY_MODE = 'ovlm_calibration_mode';

function loadBool(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function saveBool(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
}
function loadMode(): CalibrationMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY_MODE);
    if (v === 'pitching') return 'pitching';
  } catch { /* ignore */ }
  return 'hitting';
}

/** Pitching calibration is two steps: plate corners, then rubber alignment.
 *  Hitting calibration is single-step (plate only) so it goes straight to
 *  'done' after solve. */
export type PitchingCalibStep = 'plate' | 'rubber' | 'done';

export interface SessionModeSlice {
  /** Which mode the calibration wizard is currently editing. */
  calibrationMode: CalibrationMode;
  /** Whether each mode has ever been successfully calibrated (persisted). */
  hittingCalibrated:  boolean;
  pitchingCalibrated: boolean;
  /** Where in the pitching-mode flow we are. */
  pitchingCalibStep:  PitchingCalibStep;
  /** The session the user picked from the post-calibration selector. */
  activeSession: ActiveSession | null;

  setCalibrationMode:    (mode: CalibrationMode) => void;
  markModeCalibrated:    (mode: CalibrationMode) => void;
  setPitchingCalibStep:  (step: PitchingCalibStep) => void;
  startSession:          (mode: CalibrationMode, type: SessionType) => void;
  endSession:            () => void;
}

export const createSessionModeSlice: StateCreator<SessionModeSlice> = (set) => ({
  calibrationMode:    loadMode(),
  hittingCalibrated:  loadBool(STORAGE_KEY_HIT),
  pitchingCalibrated: loadBool(STORAGE_KEY_PIT),
  pitchingCalibStep:  'plate',
  activeSession:      null,

  setCalibrationMode: (mode) => {
    try { localStorage.setItem(STORAGE_KEY_MODE, mode); } catch { /* ignore */ }
    // Switching modes always resets the pitching step — otherwise re-entering
    // the wizard could land mid-flow with no plate calibration loaded.
    set({ calibrationMode: mode, pitchingCalibStep: 'plate' });
  },

  markModeCalibrated: (mode) => {
    if (mode === 'hitting')  { saveBool(STORAGE_KEY_HIT, true); set({ hittingCalibrated:  true }); }
    else                     {
      saveBool(STORAGE_KEY_PIT, true);
      // Plate solved — advance pitching to its second step (rubber alignment).
      set({ pitchingCalibrated: true, pitchingCalibStep: 'rubber' });
    }
  },

  setPitchingCalibStep: (step) => set({ pitchingCalibStep: step }),

  startSession: (mode, type) => set({
    activeSession: { mode, type, startedAt: Date.now() },
  }),

  endSession: () => set({ activeSession: null }),
});
