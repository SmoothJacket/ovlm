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
      trajectory: Array<{ x: number; y: number; z: number; t: number }>;
    }
  | { type: 'audio_level'; rms: number; peak: number; threshold: number }
  | { type: 'health'; cpuTempC: number; memUsedMb: number; memTotalMb: number; loadAvg1m: number }
  | {
      type: 'calibration';
      state: 'collecting' | 'done' | 'error';
      progress?: number;
      total?: number;
      baselineMm?: number;
      reprojPx?: number;
      rmsMm?: number;
      message?: string;
    }
  | { type: 'error'; message: string };

/** Messages the browser sends to the launch-monitor backend */
export type BrowserMessage =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'reset' }
  | { type: 'set_threshold'; value: number }
  | { type: 'calibrate' };
