/** Messages the launch-monitor backend sends to the browser */
export type PiMessage =
  | {
      type: 'status';
      state: 'idle' | 'armed' | 'capturing' | 'processing';
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
        source?: 'spincam' | 'stereo' | 'axis-corrected' | 'magnus';
        gyroDeg?: number;
        axisConfidence?: number;
      };
      evSource: 'camera' | 'radar';
      /** True when camera tracking failed and only radar EV is available.
       *  In that case launchAngle/sprayAngle/fitResidualMm are unreliable (set to 0/null). */
      radarOnly?: boolean;
      radarVelocityMps: number | null;
      pitchVelocity:    number | null;   // mph — OPS243 inbound reading (pitch speed)
      carryDistanceM:   number | null;   // metres — OPS243 FMCW range when present, else ballistic fit from stereo trajectory
      trajectory: Array<{ x: number; y: number; z: number; t: number }>;
      /** Ball position at τ=0 from the trajectory fit (feet).
       *  Hits: contact point.  Pitches: release point. */
      contactXFt?: number;
      contactYFt?: number;
      /** Trackman-style pitch metrics, present only when the trajectory was
       *  a pitch (ball travelling toward the plate). */
      pitch?: {
        release_speed_mph:   number;
        plate_speed_mph:     number;
        plate_time_s:        number;
        plate_loc_x_ft:      number;
        plate_loc_y_ft:      number;
        release_height_ft:   number;
        release_side_ft:     number;
        extension_ft:        number;
        vertical_break_in:   number;
        horizontal_break_in: number;
        total_break_in:      number;
        vaa_deg:             number;
        haa_deg:             number;
        spin_rate_rpm:       number | null;
        spin_tilt:           string | null;
        active_spin_pct:     number | null;
      };
    }
  | { type: 'health'; cpuTempC: number; memUsedMb: number; memTotalMb: number; loadAvg1m: number;
      cam0Fps?: number; cam1Fps?: number; }
  | {
      type: 'calibration';
      state: 'collecting' | 'done' | 'error';
      mode?: 'hitting' | 'pitching';   // backend echoes which mode this result is for
      progress?: number;
      total?: number;
      baselineMm?: number;
      reprojPx?: number;
      rmsMm?: number;
      message?: string;
    }
  | { type: 'error'; message: string }
  | { type: 'calib_frame'; cam0: string; cam1: string;
      cornersFound: [boolean, boolean]; step: 'align' | 'capturing' | 'done' }
  | { type: 'calib_result'; ok: boolean; reprojPx: number;
      residualMm: number; baselineMm: number; message: string }
  | { type: 'session_mode'; mode: 'hitting' | 'pitching'; calibrated: boolean }
  | { type: 'radar_status';
      pitchMph: number | null;
      evMph:    number | null;
      rangeM:   number | null;
    };

/** Messages the browser sends to the launch-monitor backend */
export type BrowserMessage =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'reset' }
  | { type: 'trigger' }   // manual capture — fires the buffer flush at "now"
  | { type: 'calibrate'; mode?: 'hitting' | 'pitching' }
  | {
      type: 'calib_manual';
      corners0: [number, number][];
      corners1: [number, number][];
      heightMm: number;
      distanceMm: number;
      mode?: 'hitting' | 'pitching';
      radarBehindMm?: number;
      radarHeightMm?: number;
    }
  | { type: 'set_session_mode'; mode: 'hitting' | 'pitching' }
  | { type: 'set_sub_session'; subType: 'tee' | 'front_toss' | 'live_bp' | null };
