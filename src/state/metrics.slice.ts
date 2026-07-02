import type { StateCreator } from 'zustand';
import type { SessionAggregates } from '@/types/pipeline';
import type { SessionSlice } from './session.slice';

export interface MetricsSlice {
  selectedSwingIds: Set<string>;
  aggregates: SessionAggregates;

  selectSwing: (id: string) => void;
  deselectSwing: (id: string) => void;
  toggleSwingSelection: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  recomputeAggregates: () => void;
}

const emptyAggregates: SessionAggregates = {
  sessionCount: 0,
  avgExitVelocity: 0,
  maxExitVelocity: 0,
  avgLaunchAngle: 0,
  avgSpinRate: 0,
  avgHipShoulderSep: 0,
  avgTorqueNm: 0,
};

export const createMetricsSlice: StateCreator<
  MetricsSlice & SessionSlice,
  [],
  [],
  MetricsSlice
> = (set, get) => ({
  selectedSwingIds: new Set(),
  aggregates: emptyAggregates,

  selectSwing: (id) =>
    set((s) => ({ selectedSwingIds: new Set([...s.selectedSwingIds, id]) })),

  deselectSwing: (id) =>
    set((s) => {
      const next = new Set(s.selectedSwingIds);
      next.delete(id);
      return { selectedSwingIds: next };
    }),

  toggleSwingSelection: (id) => {
    const { selectedSwingIds, selectSwing, deselectSwing } = get();
    selectedSwingIds.has(id) ? deselectSwing(id) : selectSwing(id);
  },

  selectAll: () =>
    set((s) => ({ selectedSwingIds: new Set(s.swings.map((sw) => sw.id)) })),

  clearSelection: () => set({ selectedSwingIds: new Set() }),

  recomputeAggregates: () => {
    const { swings, selectedSwingIds } = get();
    const selected = swings.filter((sw) => selectedSwingIds.has(sw.id));
    if (selected.length === 0) {
      set({ aggregates: emptyAggregates });
      return;
    }
    const withAngle = selected.filter((sw) => !sw.ball.radarOnly);
    const sum = selected.reduce(
      (acc, sw) => ({
        ev: acc.ev + sw.ball.exitVelocity,
        la: acc.la + (sw.ball.radarOnly ? 0 : sw.ball.launchAngle),
        spin: acc.spin + (sw.ball.seam?.spinRate ?? 0),
        hss: acc.hss + (sw.biomech?.hipShoulderSep.peakSeparationDeg ?? 0),
        torque: acc.torque + (sw.biomech?.torqueEstimateNm ?? 0),
      }),
      { ev: 0, la: 0, spin: 0, hss: 0, torque: 0 }
    );
    const n = selected.length;
    const aggregates: SessionAggregates = {
      sessionCount: n,
      avgExitVelocity: sum.ev / n,
      maxExitVelocity: Math.max(...selected.map((sw) => sw.ball.exitVelocity)),
      avgLaunchAngle: withAngle.length > 0 ? sum.la / withAngle.length : 0,
      avgSpinRate: sum.spin / n,
      avgHipShoulderSep: sum.hss / n,
      avgTorqueNm: sum.torque / n,
    };
    set({ aggregates });
  },
});
