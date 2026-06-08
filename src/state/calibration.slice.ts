import type { StateCreator } from 'zustand';
import type { CalibrationData, CalibrationState } from '@/types/calibration';
import { loadCalibration, saveCalibration, clearCalibration } from '@/modules/calibration/anchor-store';

export interface CalibrationSlice {
  calibrationData: CalibrationData | null;
  calibrationState: CalibrationState;
  /** Frame counts accumulated during current calibration session */
  capturedFrameCount: [number, number];

  setCalibration: (data: CalibrationData) => void;
  invalidateCalibration: () => void;
  loadCalibrationFromStorage: () => Promise<void>;
  incrementCapturedFrames: (cameraId: 0 | 1) => void;
  resetCapturedFrames: () => void;
}

export const createCalibrationSlice: StateCreator<CalibrationSlice> = (set) => ({
  calibrationData: null,
  calibrationState: 'none',
  capturedFrameCount: [0, 0],

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
});
