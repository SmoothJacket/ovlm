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
  audioArmed: boolean;
  errorMessage?: string;
}

export interface SwingSession {
  id: string;               // UUID
  timestamp: number;        // Unix ms
  ball: BallMeasurement;
  biomech?: BiomechData;
  hasReplayFrames: boolean;
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
