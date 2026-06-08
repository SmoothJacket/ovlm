/** Messages the Pi sends to the browser */
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
      spin?: {
        rpm: number;
        axis: [number, number, number];
        efficiency: number;
        confidence: number;
        framesUsed: number;
      };
      evSource: 'camera' | 'radar';
      radarVelocityMps: number | null;
      trajectory: Array<{ x: number; y: number; z: number; t: number }>;
    }
  | { type: 'audio_level'; rms: number; peak: number; threshold: number }
  | { type: 'health'; cpuTempC: number; memUsedMb: number; memTotalMb: number; loadAvg1m: number }
  | { type: 'error'; message: string };

/** Messages the browser sends to the Pi */
export type BrowserMessage =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'reset' }
  | { type: 'set_threshold'; value: number };
