import type { StateCreator } from 'zustand';

export type ActivePanel = 'calibration' | 'capture' | 'metrics' | 'visualization' | 'settings';

export interface OverlayFlags {
  detections: boolean;
  landmarks: boolean;
  seams: boolean;
  trajectory: boolean;
}

export interface UISlice {
  activePanel: ActivePanel;
  overlaysEnabled: OverlayFlags;
  videoPlaybackFrame: number;
  sidebarCollapsed: boolean;
  selectedStadiumId: string | null;
  cameraPreset: 'plate' | 'field';

  setPanel: (panel: ActivePanel) => void;
  toggleOverlay: (key: keyof OverlayFlags) => void;
  seekVideoTo: (frame: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setStadium: (id: string | null) => void;
  setCameraPreset: (preset: 'plate' | 'field') => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  activePanel: 'capture',
  overlaysEnabled: {
    detections: true,
    landmarks: true,
    seams: false,
    trajectory: true,
  },
  videoPlaybackFrame: 0,
  sidebarCollapsed: false,
  selectedStadiumId: null,
  cameraPreset: 'plate',

  setPanel: (panel) => set({ activePanel: panel }),

  toggleOverlay: (key) =>
    set((s) => ({
      overlaysEnabled: { ...s.overlaysEnabled, [key]: !s.overlaysEnabled[key] },
    })),

  seekVideoTo: (frame) => set({ videoPlaybackFrame: frame }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setStadium: (id) => set({ selectedStadiumId: id }),

  setCameraPreset: (preset) => set({ cameraPreset: preset }),
});
