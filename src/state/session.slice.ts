import type { StateCreator } from 'zustand';
import type { SwingSession, PipelineStatus } from '@/types/pipeline';
import type { BallMeasurement } from '@/types/tracking';
import type { PiMessage } from '@/ws/messages';

type MeasurementMsg = Extract<PiMessage, { type: 'measurement' }>;

export interface AudioLevel {
  rms: number;
  peak: number;
  threshold: number;
}

export interface PiHealth {
  cpuTempC:   number;
  memUsedMb:  number;
  memTotalMb: number;
  loadAvg1m:  number;
}

export interface CalibrationProgress {
  state: 'collecting' | 'done' | 'error';
  progress?: number;
  total?: number;
  baselineMm?: number;
  reprojPx?: number;
  rmsMm?: number;
  message?: string;
}

export interface SessionSlice {
  swings: SwingSession[];
  activeSwingId: string | null;
  pipelineStatus: PipelineStatus;
  wsHost: string;
  audioLevel: AudioLevel | null;
  piHealth:   PiHealth | null;
  calibrationProgress: CalibrationProgress | null;
  allTimeBestEv:   number;
  newRecordSwingId: string | null;   // set for ~3s when a swing beats the all-time record

  addSwing: (session: SwingSession) => void;
  setActiveSwing: (id: string | null) => void;
  updatePipelineStatus: (patch: Partial<PipelineStatus>) => void;
  ingestPiMeasurement: (msg: MeasurementMsg) => void;
  setWsHost: (host: string) => void;
  clearSwings: () => void;
  updateAudioLevel: (level: AudioLevel) => void;
  updatePiHealth:   (health: PiHealth) => void;
  updateCalibrationProgress: (progress: CalibrationProgress) => void;
  clearNewRecord: () => void;
}

const defaultPipelineStatus: PipelineStatus = {
  state: 'idle',
  wsConnected: false,
  latencyMs: 0,
  audioArmed: false,
};

const STORAGE_KEY_HOST   = 'ovlm_pi_host';
const STORAGE_KEY_ATR    = 'ovlm_all_time_ev';   // all-time record EV

// Backend runs on this machine since the NUC port — migrate the stale
// Raspberry Pi default if it's what's saved, but leave custom hosts alone.
const DEFAULT_WS_HOST = 'ws://localhost:8765';
function loadWsHost(): string {
  const saved = localStorage.getItem(STORAGE_KEY_HOST);
  if (saved == null || saved === 'ws://raspberrypi.local:8765') return DEFAULT_WS_HOST;
  return saved;
}

export const createSessionSlice: StateCreator<SessionSlice> = (set) => ({
  swings: [],
  activeSwingId: null,
  pipelineStatus: defaultPipelineStatus,
  wsHost: loadWsHost(),
  audioLevel: null,
  piHealth:   null,
  calibrationProgress: null,
  allTimeBestEv:    parseFloat(localStorage.getItem(STORAGE_KEY_ATR) ?? '0') || 0,
  newRecordSwingId: null,

  addSwing: (session) =>
    set((s) => {
      const ev = session.ball.exitVelocity;
      const isRecord = ev > s.allTimeBestEv;
      if (isRecord) localStorage.setItem(STORAGE_KEY_ATR, String(ev));
      return {
        swings: [session, ...s.swings],
        activeSwingId: session.id,
        ...(isRecord && { allTimeBestEv: ev, newRecordSwingId: session.id }),
      };
    }),

  setActiveSwing: (id) => set({ activeSwingId: id }),

  updatePipelineStatus: (patch) =>
    set((s) => ({
      pipelineStatus: { ...s.pipelineStatus, ...patch },
    })),

  ingestPiMeasurement: (msg) =>
    set((s) => {
      const ball: BallMeasurement = {
        exitVelocity: msg.exitVelocity,
        launchAngle: msg.launchAngle,
        sprayAngle: msg.sprayAngle,
        seam: msg.spin
          ? {
              spinRate: msg.spin.rpm,
              spinAxis: msg.spin.axis,
              spinEfficiency: msg.spin.efficiency,
              seamFrames: [],
              confidence: msg.spin.confidence,
            }
          : null,
        contactFrameIndex: 0,
        processingLatencyMs: msg.latencyMs,
        detectRate: msg.detectRate,
        evSource: msg.evSource,
        radarVelocityMph: msg.radarVelocityMps != null
          ? Math.round(msg.radarVelocityMps * 2.23694 * 10) / 10
          : null,
        trajectory: msg.trajectory.map((p) => ({
          x: p.x, y: p.y, z: p.z,
          timestamp: p.t * 1_000_000,
        })),
      };
      const session: SwingSession = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        ball,
        hasReplayFrames: false,
      };
      const isRecord = ball.exitVelocity > s.allTimeBestEv;
      if (isRecord) {
        localStorage.setItem(STORAGE_KEY_ATR, String(ball.exitVelocity));
      }
      return {
        swings: [session, ...s.swings],
        activeSwingId: session.id,
        pipelineStatus: {
          ...s.pipelineStatus,
          latencyMs: msg.latencyMs,
          state: 'armed',
        },
        ...(isRecord && {
          allTimeBestEv:    ball.exitVelocity,
          newRecordSwingId: session.id,
        }),
      };
    }),

  setWsHost: (host) => {
    localStorage.setItem(STORAGE_KEY_HOST, host);
    set({ wsHost: host });
  },

  clearSwings: () => set({ swings: [], activeSwingId: null }),

  updateAudioLevel: (level)  => set({ audioLevel: level }),
  updatePiHealth:   (health) => set({ piHealth: health }),
  updateCalibrationProgress: (progress) => set({ calibrationProgress: progress }),
  clearNewRecord:   ()       => set({ newRecordSwingId: null }),
});
