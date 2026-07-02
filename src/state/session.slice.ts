import type { StateCreator } from 'zustand';
import type { SwingSession, PipelineStatus } from '@/types/pipeline';
import type { BallMeasurement } from '@/types/tracking';
import type { PiMessage } from '@/ws/messages';

type MeasurementMsg = Extract<PiMessage, { type: 'measurement' }>;

export interface PiHealth {
  cpuTempC:   number;
  memUsedMb:  number;
  memTotalMb: number;
  loadAvg1m:  number;
  cam0Fps?: number;
  cam1Fps?: number;
}

export interface CalibrationProgress {
  state: 'collecting' | 'done' | 'error';
  mode?: 'hitting' | 'pitching';
  progress?: number;
  total?: number;
  baselineMm?: number;
  reprojPx?: number;
  rmsMm?: number;
  message?: string;
}

export interface RadarStatus {
  pitchMph: number | null;
  evMph:    number | null;
  rangeM:   number | null;
  /** Wall-clock ms when this update arrived — used to grey out the readout
   *  if the radar stops sending. */
  receivedAt: number;
}

export interface SessionSlice {
  swings: SwingSession[];
  activeSwingId: string | null;
  pipelineStatus: PipelineStatus;
  wsHost: string;
  piHealth:   PiHealth | null;
  radarStatus: RadarStatus | null;
  calibrationProgress: CalibrationProgress | null;
  allTimeBestEv:   number;
  newRecordSwingId: string | null;   // set for ~3s when a swing beats the all-time record

  addSwing: (session: SwingSession) => void;
  setActiveSwing: (id: string | null) => void;
  updatePipelineStatus: (patch: Partial<PipelineStatus>) => void;
  ingestPiMeasurement: (msg: MeasurementMsg) => void;
  setWsHost: (host: string) => void;
  clearSwings: () => void;
  updatePiHealth:   (health: PiHealth) => void;
  updateRadarStatus:(status: Omit<RadarStatus, 'receivedAt'>) => void;
  updateCalibrationProgress: (progress: CalibrationProgress) => void;
  clearNewRecord: () => void;
}

const defaultPipelineStatus: PipelineStatus = {
  state: 'idle',
  wsConnected: false,
  latencyMs: 0,
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
  piHealth:   null,
  radarStatus: null,
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
              gyroDeg: msg.spin.gyroDeg ?? 0,
              axisConfidence: msg.spin.axisConfidence ?? 1,
            }
          : null,
        contactFrameIndex: 0,
        processingLatencyMs: msg.latencyMs,
        detectRate: msg.detectRate,
        evSource: msg.evSource,
        radarOnly: msg.radarOnly ?? false,
        radarVelocityMph: msg.radarVelocityMps != null
          ? Math.round(msg.radarVelocityMps * 2.23694 * 10) / 10
          : null,
        pitchVelocityMph: msg.pitchVelocity ?? null,
        carryDistanceM:   msg.carryDistanceM ?? null,
        contactXFt: msg.contactXFt,
        contactYFt: msg.contactYFt,
        trajectory: msg.trajectory.map((p) => ({
          x: p.x, y: p.y, z: p.z,
          timestamp: p.t * 1_000_000,
        })),
        pitch: msg.pitch ? {
          releaseSpeedMph:    msg.pitch.release_speed_mph,
          plateSpeedMph:      msg.pitch.plate_speed_mph,
          plateTimeS:         msg.pitch.plate_time_s,
          plateLocXFt:        msg.pitch.plate_loc_x_ft,
          plateLocYFt:        msg.pitch.plate_loc_y_ft,
          releaseHeightFt:    msg.pitch.release_height_ft,
          releaseSideFt:      msg.pitch.release_side_ft,
          extensionFt:        msg.pitch.extension_ft,
          verticalBreakIn:    msg.pitch.vertical_break_in,
          horizontalBreakIn:  msg.pitch.horizontal_break_in,
          totalBreakIn:       msg.pitch.total_break_in,
          vaaDeg:             msg.pitch.vaa_deg,
          haaDeg:             msg.pitch.haa_deg,
          spinRateRpm:        msg.pitch.spin_rate_rpm,
          spinTilt:           msg.pitch.spin_tilt,
          activeSpinPct:      msg.pitch.active_spin_pct,
        } : null,
      };
      // Tag the swing with whatever sub-session is currently active.
      // Cast through unknown because DrillSessionSlice is composed in the
      // root store but not visible to this individual slice creator.
      const drillState = s as unknown as { activeSubSession?: { id: string; type: import('@/types/pipeline').SubSessionType } | null };
      const session: SwingSession = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        ball,
        hasReplayFrames: false,
        subSessionId:   drillState.activeSubSession?.id,
        subSessionType: drillState.activeSubSession?.type,
      };
      const isRecord = !ball.pitch && ball.exitVelocity > s.allTimeBestEv;
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

  updatePiHealth:   (health) => set({ piHealth: health }),
  updateRadarStatus: (status) =>
    set({ radarStatus: { ...status, receivedAt: Date.now() } }),
  updateCalibrationProgress: (progress) => set({ calibrationProgress: progress }),
  clearNewRecord:   ()       => set({ newRecordSwingId: null }),
});
