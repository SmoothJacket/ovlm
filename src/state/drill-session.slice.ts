import type { StateCreator } from 'zustand';
import type { MasterSession, SubSession, SubSessionType } from '@/types/pipeline';
import { piClient } from '@/ws/client';

const SUB_LABELS: Record<SubSessionType, string> = {
  tee:        'Tee Work',
  front_toss: 'Front Toss',
  live_bp:    'Live BP',
};

export interface DrillSessionSlice {
  masterSession:    MasterSession | null;
  activeSubSession: SubSession | null;
  subSessions:      SubSession[];

  startMasterSession:  () => void;
  endMasterSession:    () => void;
  startSubSession:     (type: SubSessionType) => void;
  endSubSession:       () => void;
}

export const createDrillSessionSlice: StateCreator<DrillSessionSlice> = (set, get) => ({
  masterSession:    null,
  activeSubSession: null,
  subSessions:      [],

  startMasterSession: () =>
    set({
      masterSession: {
        id:        crypto.randomUUID(),
        date:      new Date().toISOString().slice(0, 10),
        startedAt: Date.now(),
      },
      activeSubSession: null,
      subSessions:      [],
    }),

  endMasterSession: () => {
    const { activeSubSession } = get();
    if (activeSubSession) piClient.send({ type: 'set_sub_session', subType: null });
    set({
      masterSession:    null,
      activeSubSession: null,
      subSessions:      activeSubSession
        ? get().subSessions.map((s) =>
            s.id === activeSubSession.id ? { ...s, endedAt: Date.now() } : s,
          )
        : get().subSessions,
    });
  },

  startSubSession: (type) => {
    const now = Date.now();
    const { activeSubSession, subSessions } = get();
    const closed = activeSubSession
      ? subSessions.map((s) =>
          s.id === activeSubSession.id ? { ...s, endedAt: now } : s,
        )
      : subSessions;
    const next: SubSession = {
      id:        crypto.randomUUID(),
      type,
      label:     SUB_LABELS[type],
      startedAt: now,
    };
    piClient.send({ type: 'set_sub_session', subType: type });
    set({ activeSubSession: next, subSessions: [...closed, next] });
  },

  endSubSession: () => {
    const { activeSubSession, subSessions } = get();
    if (!activeSubSession) return;
    piClient.send({ type: 'set_sub_session', subType: null });
    set({
      activeSubSession: null,
      subSessions: subSessions.map((s) =>
        s.id === activeSubSession.id ? { ...s, endedAt: Date.now() } : s,
      ),
    });
  },
});

export const SUB_SESSION_LABELS = SUB_LABELS;
