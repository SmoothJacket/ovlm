/** Messages the launch-monitor backend sends to the browser */
export type PiMessage =
  | {
      type: 'status';
      state: 'idle' | 'armed' | 'capturing' | 'processing';
      audioArmed?: boolean;
    }
  | {
      type: 'measurement';
      exitVelocity: number;    // mph
      launchAngle: number;     // degrees
      sprayAngle: number;      // degrees
      fitResidualMm: number;
      latencyMs: number;
      detectRate: number;
      /** Inlier / rejected point counts from the trajectory fit (newer backends) */
      pointsUsed?: number;
      pointsRejected?: number;
      spin?: {
        rpm: number;
        axis: [number, number, number];
        efficiency: number;
        confidence: number;
        framesUsed: number;
        /** Which camera measured spin: dedicated high-fps cam or stereo cam 0 */
        source?: 'spincam' | 'stereo';
      };
      evSource: 'camera' | 'radar';
      radarVelocityMps: number | null;
      pitchVelocity:    number | null;   // mph — OPS243 inbound reading (pitch speed)
      carryDistanceM:   number | null;   // metres — OPS243 FMCW range at peak distance
      trajectory: Array<{ x: number; y: number; z: number; t: number }>;
    }
  | { type: 'audio_level'; rms: number; peak: number; threshold: number }
  | { type: 'health'; cpuTempC: number; memUsedMb: number; memTotalMb: number; loadAvg1m: number }
  | { type: 'error'; message: string }
  | { type: 'calib_frame'; cam0: string; cam1: string;
      cornersFound: [boolean, boolean]; step: 'align' | 'capturing' | 'done' }
  | { type: 'calib_result'; ok: boolean; reprojPx: number;
      residualMm: number; baselineMm: number; message: string };

/** Messages the browser sends to the launch-monitor backend */
export type BrowserMessage =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'reset' }
  | { type: 'set_threshold'; value: number }
  | { type: 'calib_start'; heightMm: number; distanceMm: number }
  | { type: 'calib_capture' }
  | { type: 'calib_stop' };
