/**
 * Pipeline state and session types.
 */

import type { BallMeasurement } from './tracking';
import type { BiomechData } from './biomechanics';

export type PipelineState =
  | 'idle'
  | 'calibrating'
  | 'armed'        // listening for audio trigger
  | 'capturing'    // active frame buffering post-trigger
  | 'processing'   // workers computing results
  | 'error';

export interface PipelineStatus {
  state: PipelineState;
  /** Whether the WebSocket connection to the Pi is open */
  wsConnected: boolean;
  /** Last measured end-to-end latency in ms reported by Pi */
  latencyMs: number;
  errorMessage?: string;
}

export type SubSessionType = 'tee' | 'front_toss' | 'live_bp';

export interface SubSession {
  id: string;
  type: SubSessionType;
  label: string;
  startedAt: number;   // Unix ms
  endedAt?: number;
}

export interface MasterSession {
  id: string;
  date: string;        // YYYY-MM-DD
  startedAt: number;
}

export interface SwingSession {
  id: string;               // UUID
  timestamp: number;        // Unix ms
  ball: BallMeasurement;
  biomech?: BiomechData;
  hasReplayFrames: boolean;
  subSessionId?: string;
  subSessionType?: SubSessionType;
}

/** Aggregated stats across selected sessions */
export interface SessionAggregates {
  sessionCount: number;
  avgExitVelocity: number;  // mph
  maxExitVelocity: number;
  avgLaunchAngle: number;
  avgSpinRate: number;      // RPM
  avgHipShoulderSep: number;
  avgTorqueNm: number;
}
