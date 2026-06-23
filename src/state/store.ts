import { create } from 'zustand';
import { createCalibrationSlice, type CalibrationSlice } from './calibration.slice';
import { createSessionSlice, type SessionSlice } from './session.slice';
import { createMetricsSlice, type MetricsSlice } from './metrics.slice';
import { createUISlice, type UISlice } from './ui.slice';
import { createSettingsSlice, type SettingsSlice } from './settings.slice';

export type OVLMStore = CalibrationSlice & SessionSlice & MetricsSlice & UISlice & SettingsSlice;

export const useStore = create<OVLMStore>()((...args) => ({
  ...createCalibrationSlice(...args),
  ...createSessionSlice(...args),
  ...createMetricsSlice(...args),
  ...createUISlice(...args),
  ...createSettingsSlice(...args),
}));

// Typed selectors for common access patterns
export const useCalibration = () => useStore((s) => s.calibrationData);
export const useCalibrationState = () => useStore((s) => s.calibrationState);
export const usePipelineStatus = () => useStore((s) => s.pipelineStatus);
export const useCalibrationProgress = () => useStore((s) => s.calibrationProgress);
export const useWsHost = () => useStore((s) => s.wsHost);
export const useActiveSwing = () =>
  useStore((s) => s.swings.find((sw) => sw.id === s.activeSwingId) ?? null);
export const useSwings = () => useStore((s) => s.swings);
export const useUIPanel = () => useStore((s) => s.activePanel);
export const useOverlays = () => useStore((s) => s.overlaysEnabled);
export const useSelectedStadium = () => useStore((s) => s.selectedStadiumId);
export const useCameraPreset = () => useStore((s) => s.cameraPreset);
