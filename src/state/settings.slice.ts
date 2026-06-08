import type { StateCreator } from 'zustand';

const STORAGE_KEY = 'ovlm_settings';

export interface AppSettings {
  evUnit:          'mph' | 'kph';
  streakThreshold: number;           // mph — consecutive swings at/above this build a streak
  laOptimalMin:    number;           // degrees — launch angle optimal range (low)
  laOptimalMax:    number;           // degrees — launch angle optimal range (high)
}

const DEFAULTS: AppSettings = {
  evUnit:          'mph',
  streakThreshold: 90,
  laOptimalMin:    8,
  laOptimalMax:    32,
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function save(s: AppSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export interface SettingsSlice {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings:  () => void;
}

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  settings: load(),

  updateSettings: (patch) =>
    set((s) => {
      const next = { ...s.settings, ...patch };
      save(next);
      return { settings: next };
    }),

  resetSettings: () =>
    set(() => {
      save(DEFAULTS);
      return { settings: { ...DEFAULTS } };
    }),
});
