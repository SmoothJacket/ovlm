import type { StateCreator } from 'zustand';

export type ActivePanel = 'calibration' | 'capture' | 'metrics' | 'visualization' | 'cage' | 'settings';

export interface OverlayFlags {
  detections: boolean;
  landmarks: boolean;
  seams: boolean;
  trajectory: boolean;
}

export type Viewer3DMode = 'ovlm' | 'hittrax';

export interface UISlice {
  activePanel: ActivePanel;
  overlaysEnabled: OverlayFlags;
  videoPlaybackFrame: number;
  sidebarCollapsed: boolean;
  selectedStadiumId: string | null;
  cameraPreset: 'plate' | 'field';
  viewer3DMode: Viewer3DMode;

  setPanel: (panel: ActivePanel) => void;
  toggleOverlay: (key: keyof OverlayFlags) => void;
  seekVideoTo: (frame: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setStadium: (id: string | null) => void;
  setCameraPreset: (preset: 'plate' | 'field') => void;
  setViewer3DMode: (mode: Viewer3DMode) => void;
}

const STORAGE_KEY_3D_MODE = 'ovlm_viewer3d_mode';

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
  viewer3DMode: (localStorage.getItem(STORAGE_KEY_3D_MODE) === 'hittrax' ? 'hittrax' : 'ovlm') as Viewer3DMode,

  setPanel: (panel) => set({ activePanel: panel }),

  toggleOverlay: (key) =>
    set((s) => ({
      overlaysEnabled: { ...s.overlaysEnabled, [key]: !s.overlaysEnabled[key] },
    })),

  seekVideoTo: (frame) => set({ videoPlaybackFrame: frame }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setStadium: (id) => set({ selectedStadiumId: id }),

  setCameraPreset: (preset) => set({ cameraPreset: preset }),

  setViewer3DMode: (mode) => {
    localStorage.setItem(STORAGE_KEY_3D_MODE, mode);
    set({ viewer3DMode: mode });
  },
});
