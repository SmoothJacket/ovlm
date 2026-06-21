import type { StateCreator } from 'zustand';
import type { CalibrationData, CalibrationState } from '@/types/calibration';
import { loadCalibration, saveCalibration, clearCalibration } from '@/modules/calibration/anchor-store';

export interface CalibFrame {
  cam0: string;
  cam1: string;
  cornersFound: [boolean, boolean];
}

export interface CalibWizardResult {
  ok: boolean;
  reprojPx: number;
  residualMm: number;
  baselineMm: number;
  message: string;
}

export interface CalibrationSlice {
  calibrationData: CalibrationData | null;
  calibrationState: CalibrationState;
  capturedFrameCount: [number, number];

  // Guided wizard state
  wizardStep: 0 | 1 | 2 | 3;
  heightFt: number;
  heightIn: number;
  distFt: number;
  distIn: number;
  lastFrame: CalibFrame | null;
  lastCalibResult: CalibWizardResult | null;

  setCalibration: (data: CalibrationData) => void;
  invalidateCalibration: () => void;
  loadCalibrationFromStorage: () => Promise<void>;
  incrementCapturedFrames: (cameraId: 0 | 1) => void;
  resetCapturedFrames: () => void;
  setWizardStep: (step: 0 | 1 | 2 | 3) => void;
  setCalibMeasurements: (h: { ft: number; in: number }, d: { ft: number; in: number }) => void;
  setLastFrame: (frame: CalibFrame) => void;
  setCalibWizardResult: (result: CalibWizardResult) => void;
  resetWizard: () => void;
}

export const createCalibrationSlice: StateCreator<CalibrationSlice> = (set) => ({
  calibrationData: null,
  calibrationState: 'none',
  capturedFrameCount: [0, 0],

  wizardStep: 0,
  heightFt: 5,
  heightIn: 0,
  distFt: 8,
  distIn: 0,
  lastFrame: null,
  lastCalibResult: null,

  setCalibration: (data) => {
    saveCalibration(data).catch(console.error);
    set({ calibrationData: data, calibrationState: 'complete' });
  },

  invalidateCalibration: () => {
    clearCalibration().catch(console.error);
    set({ calibrationData: null, calibrationState: 'none' });
  },

  loadCalibrationFromStorage: async () => {
    const data = await loadCalibration();
    if (data) {
      set({ calibrationData: data, calibrationState: 'complete' });
    }
  },

  incrementCapturedFrames: (cameraId) =>
    set((s) => {
      const counts = [...s.capturedFrameCount] as [number, number];
      counts[cameraId]++;
      return { capturedFrameCount: counts };
    }),

  resetCapturedFrames: () => set({ capturedFrameCount: [0, 0] }),

  setWizardStep: (step) => set({ wizardStep: step }),

  setCalibMeasurements: (h, d) =>
    set({ heightFt: h.ft, heightIn: h.in, distFt: d.ft, distIn: d.in }),

  setLastFrame: (frame) => set({ lastFrame: frame }),

  setCalibWizardResult: (result) => set({ lastCalibResult: result }),

  resetWizard: () => set({
    wizardStep: 0,
    lastFrame: null,
    lastCalibResult: null,
  }),
});
