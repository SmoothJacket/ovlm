"""
Core tracking pipeline — runs on the NUC.

Receives flushed frame windows from FrameBuffer, runs:
  - ROI ball tracking (both stereo cameras)
  - Seam-based spin estimation (dedicated high-fps spin camera when present,
    otherwise stereo camera 0)
  - Stereo triangulation
  - Robust ballistic trajectory fitting
  - Launch metric calculation
and broadcasts results via WebSocket.
"""

import dataclasses
import logging
import math
import time
from typing import List, Optional

import numpy as np

import config
from capture import FramePair
from pitch_metrics import compute_pitch_metrics, pitch_metrics_to_dict
from seam_tracker import SeamTracker, SpinMeasurement
from tracker import BallTracker
from trajectory import TrajectoryFitter, LaunchMetrics
from triangulate import Point3D, Triangulator

log = logging.getLogger(__name__)

MPS_TO_MPH = 2.23694


class TrackingPipeline:
    def __init__(self, server, ops243=None, spin_ring=None, get_sub_session=None) -> None:
        self._server          = server
        self._ops243          = ops243           # optional OPS243Reader (OmniPreSense)
        self._spin_ring       = spin_ring        # optional SpinFrameRing (640 fps spin cam)
        self._get_sub_session = get_sub_session  # () -> str|None — current sub-session type
        self._tracker0     = BallTracker()
        self._tracker1     = BallTracker()
        self._tracker_spin = BallTracker(
            min_radius=config.SPIN_BALL_MIN_RADIUS_PX,
            max_radius=config.SPIN_BALL_MAX_RADIUS_PX,
        )
        self._seam         = SeamTracker()   # camera 0
        self._seam1        = SeamTracker()   # camera 1 — independent rate estimate
        self._triangulator = Triangulator()
        self._fitter       = TrajectoryFitter()

        if not self._triangulator.is_calibrated:
            log.warning(
                "No calibration file found (%s). Calibrate first for accurate "
                "measurements: plate_calib.py --live (just needs a home plate in "
                "view) or calibrate.py --live (ChArUco board).",
                config.CALIBRATION_FILE,
            )

    def reload_calibration(self) -> None:
        """Re-read config.CALIBRATION_FILE — called after a calibration run
        completes so the new geometry applies without restarting main.py."""
        self._triangulator = Triangulator()
        log.info("Calibration reloaded (is_calibrated=%s)", self._triangulator.is_calibrated)

    def process(self, frames: List[FramePair], trigger_time: float) -> None:
        t_start = time.monotonic()
        log.info("Processing %d frame pairs …", len(frames))

        self._tracker0.reset()
        self._tracker1.reset()
        self._seam.reset()
        self._seam1.reset()

        # Spin source: dedicated 640 fps camera when its window has frames,
        # otherwise fall back to stereo camera 0 inside the loop below.
        spin_frames = []
        if self._spin_ring is not None:
            spin_frames = self._spin_ring.window(
                trigger_time - config.HALF_WINDOW_S,
                trigger_time + config.HALF_WINDOW_S,
            )
        use_spin_cam = len(spin_frames) > 0
        spin_source = 'spincam' if use_spin_cam else 'stereo'

        # Time window for which 3D points are valid.
        # For EV (main pipeline, ops243 present): ball leaves contact just before
        # the trigger. Use a tight post-trigger window — pre-trigger frames have
        # the ball sitting stationary on the tee and will dominate the trajectory fit.
        # For pitch (pitch pipeline, no ops243): ball is incoming, so use pre-trigger.
        if self._ops243 is not None:   # EV / hit capture
            _pt_lo = trigger_time - 0.10   # 0.10 s before (ball still near plate)
            _pt_hi = trigger_time + 0.50   # 0.50 s after  (ball in outfield flight)
        else:                          # pitch capture
            _pt_lo = trigger_time - 0.65   # 0.65 s before (ball in air from pitcher)
            _pt_hi = trigger_time + 0.10   # 0.10 s after  (ball through the zone)

        points: List[Point3D] = []

        for frame_idx, pair in enumerate(frames):
            d0 = self._tracker0.update(pair.left,  frame_idx)
            d1 = self._tracker1.update(pair.right, frame_idx)

            # Feed seam trackers from both cameras unless the spin camera covers it.
            # Require a minimum ball radius: below ~6 px the seam features are
            # too small for phase correlation to resolve, and the frame's only
            # value is in the trajectory fit (handled below via triangulate).
            if not use_spin_cam:
                if d0 is not None and d0.radius >= config.BALL_MIN_RADIUS_SEAM_PX:
                    self._seam.process_frame(pair.left,  d0, pair.timestamp, frame_idx)
                if d1 is not None and d1.radius >= config.BALL_MIN_RADIUS_SEAM_PX:
                    self._seam1.process_frame(pair.right, d1, pair.timestamp, frame_idx)

            if d0 is None or d1 is None:
                continue

            # Skip frames outside the ball-flight window to avoid fitting
            # stationary background objects (e.g. ball on tee, batter's body).
            if not (_pt_lo <= pair.timestamp <= _pt_hi):
                continue

            pt = self._triangulator.triangulate(
                d0.cx, d0.cy,
                d1.cx, d1.cy,
                pair.timestamp,
            )
            points.append(pt)

        # ── Tracking quality log ─────────────────────────────────────────────
        t0, t1 = self._tracker0, self._tracker1
        log.info(
            "Cam0: %d/%d detected (%d searched, %d tracked)  |  "
            "Cam1: %d/%d detected (%d searched, %d tracked)",
            t0.frames_detected, len(frames), t0.frames_searched, t0.frames_tracked,
            t1.frames_detected, len(frames), t1.frames_searched, t1.frames_tracked,
        )

        # ── Spin ─────────────────────────────────────────────────────────────
        if use_spin_cam:
            self._tracker_spin.reset()
            for idx, sf in enumerate(spin_frames):
                det = self._tracker_spin.update(sf.frame, idx)
                if det is not None:
                    self._seam.process_frame(sf.frame, det, sf.timestamp, idx)
            log.info(
                "Spin cam: %d/%d frames with ball detected",
                self._tracker_spin.frames_detected, len(spin_frames),
            )

        # ── Trajectory + metrics ─────────────────────────────────────────────
        latency_ms = (time.monotonic() - t_start) * 1000.0
        metrics: Optional[LaunchMetrics] = self._fitter.fit(points, latency_ms)

        if metrics is None:
            log.warning("Not enough 3D points (%d) — need at least 3", len(points))
            self._server.broadcast({"type": "status", "state": "armed"})
            return

        detect_rate = len(points) / max(len(frames), 1)

        # ── Validity gate — reject junk fits before broadcasting ─────────────
        # A trigger can fire on motion that isn't actually a ball flight
        # (lighting flicker, the operator's arm, the bat itself crossing the
        # plate with no contact). Drop anything that can't physically be a
        # struck ball so the metrics dashboard isn't polluted with noise.
        rejects = []
        if metrics.exit_velocity_mph < config.MEAS_MIN_EV_MPH:
            rejects.append(f"EV {metrics.exit_velocity_mph:.1f} < {config.MEAS_MIN_EV_MPH:.0f} mph floor")
        if metrics.exit_velocity_mph > config.MEAS_MAX_EV_MPH:
            rejects.append(f"EV {metrics.exit_velocity_mph:.1f} > {config.MEAS_MAX_EV_MPH:.0f} mph ceiling")
        if metrics.fit_residual_mm > config.MEAS_MAX_RESIDUAL_MM:
            rejects.append(f"residual {metrics.fit_residual_mm:.1f} mm > {config.MEAS_MAX_RESIDUAL_MM:.0f} mm")
        if metrics.points_used < config.MEAS_MIN_POINTS_USED:
            rejects.append(f"only {metrics.points_used} inlier pts < {config.MEAS_MIN_POINTS_USED} required")
        if detect_rate < config.MEAS_MIN_DETECT_RATE:
            rejects.append(f"detect_rate {detect_rate*100:.0f}% < {config.MEAS_MIN_DETECT_RATE*100:.0f}%")
        if rejects:
            log.info("Reject candidate measurement — %s", "; ".join(rejects))
            # Always drain the radar buffer so stale readings don't bleed into
            # the next trigger. If radar has a plausible EV, broadcast it as a
            # radar-only measurement so the UI shows speed even when camera
            # tracking fails.
            if self._ops243 is not None:
                raw_ev  = self._ops243.peak_ev_mph()
                pit_mph = self._ops243.latest_pitch_mph()
                self._ops243.clear()
                bore_cos = abs(float(config.OPS243_BORE_UNIT[2]))
                if raw_ev is not None and bore_cos > 0.1:
                    radar_ev = raw_ev / bore_cos * config.OPS243_EV_SCALE
                    if config.MEAS_MIN_EV_MPH <= radar_ev <= config.MEAS_MAX_EV_MPH:
                        log.info("Radar-only fallback: raw=%.1f  corrected=%.1f mph", raw_ev, radar_ev)
                        sub = self._get_sub_session() if self._get_sub_session else None
                        pv  = round(pit_mph, 2) if pit_mph is not None and sub != 'tee' else None
                        self._server.broadcast({
                            "type":             "measurement",
                            "exitVelocity":     round(radar_ev, 2),
                            "launchAngle":      0,
                            "sprayAngle":       0,
                            "fitResidualMm":    0,
                            "latencyMs":        round((time.monotonic() - t_start) * 1000),
                            "detectRate":       round(detect_rate, 3),
                            "pointsUsed":       metrics.points_used,
                            "pointsRejected":   metrics.points_rejected,
                            "evSource":         "radar",
                            "radarOnly":        True,
                            "radarVelocityMps": round(radar_ev / MPS_TO_MPH, 3),
                            "pitchVelocity":    pv,
                            "carryDistanceM":   None,
                            "contactXFt":       None,
                            "contactYFt":       None,
                            "trajectory":       [],
                        })
                        return
            self._server.broadcast({"type": "status", "state": "armed"})
            return

        # ── Radar cross-check ─────────────────────────────────────────────────
        radar_velocity_mps: Optional[float] = None
        pitch_velocity_mph: Optional[float] = None
        # Camera-derived carry from the ballistic fit; OPS243 range overrides it
        # if available (radar measures actual range, fit only predicts landing).
        carry_distance_m:   Optional[float] = (
            metrics.carry_distance_m if metrics.carry_distance_m > 0 else None
        )
        carry_source = 'camera' if carry_distance_m is not None else None
        ev_source = 'camera'

        # OPS243-C-FC-RP (primary radar — pitch speed, EV, FMCW range)
        if self._ops243 is not None:
            ops_ev_mph    = self._ops243.peak_ev_mph()
            ops_pitch_mph = self._ops243.latest_pitch_mph()
            ops_range_m   = self._ops243.latest_range_m()
            self._ops243.clear()

            sub_session = self._get_sub_session() if self._get_sub_session else None
            if ops_pitch_mph is not None and sub_session != "tee":
                pitch_velocity_mph = round(ops_pitch_mph, 2)

            if ops_range_m is not None:
                carry_distance_m = round(ops_range_m, 3)
                carry_source     = 'radar'

            if ops_ev_mph is not None:
                # Exact per-shot cosine correction: radar measures v_true × cos(θ)
                # where θ is the angle between the ball's velocity and the bore axis.
                # The camera gives the true 3-D velocity vector, so θ is computed
                # exactly for each hit — no approximation from spray/launch angles.
                _bore = np.array(config.OPS243_BORE_UNIT)
                _vhat = np.array([metrics.vx0, metrics.vy0, metrics.vz0])
                _vnorm = float(np.linalg.norm(_vhat))
                if _vnorm > 0:
                    cos_theta = abs(float(np.dot(_vhat / _vnorm, _bore)))
                    if cos_theta >= 0.25:   # reject if > ~75° off bore — correction too large
                        raw_ev    = ops_ev_mph
                        ops_ev_mph = raw_ev / cos_theta * config.OPS243_EV_SCALE
                        log.debug(
                            "OPS243 exact cosine: raw=%.1f  cos=%.3f (%.1f°)  corrected=%.1f mph  scale=%.3f",
                            raw_ev, cos_theta, math.degrees(math.acos(cos_theta)), ops_ev_mph,
                            config.OPS243_EV_SCALE,
                        )
                    else:
                        log.info("OPS243 EV skipped — %.1f° from bore (too oblique)",
                                 math.degrees(math.acos(cos_theta)))
                        ops_ev_mph = None
                else:
                    ops_ev_mph = None

            if ops_ev_mph is not None:
                cam_mph = metrics.exit_velocity_mph
                agree   = abs(ops_ev_mph - cam_mph) / max(cam_mph, 1) <= config.OPS243_AGREE_FRACTION
                radar_velocity_mps = ops_ev_mph / MPS_TO_MPH
                if agree:
                    metrics   = dataclasses.replace(metrics, exit_velocity_mph=round(ops_ev_mph, 2))
                    ev_source = 'radar'
                    log.info("OPS243 EV %.1f mph (camera=%.1f mph, Δ=%.1f%%)",
                             ops_ev_mph, cam_mph,
                             100 * abs(ops_ev_mph - cam_mph) / max(cam_mph, 1))
                else:
                    log.info("OPS243 EV %.1f mph disagrees with camera %.1f mph "
                             "(Δ=%.1f%% > %.0f%% tolerance) — keeping camera",
                             ops_ev_mph, cam_mph,
                             100 * abs(ops_ev_mph - cam_mph) / max(cam_mph, 1),
                             config.OPS243_AGREE_FRACTION * 100)

        # ── Magnus axis (computed first — drives spin estimation) ────────────
        # v × F_magnus gives the 3-D spin axis direction from trajectory
        # curvature. Computing this before the seam step lets us apply a
        # gyro correction so breaking balls with gyro spin are no longer
        # systematically underestimated.
        f_vec = np.array([metrics.magnus_ax, metrics.magnus_ay, metrics.magnus_az])
        v_vec = np.array([metrics.vx0,       metrics.vy0,       metrics.vz0])
        f_mag = float(np.linalg.norm(f_vec))
        v_mag = float(np.linalg.norm(v_vec))

        magnus_axis: Optional[tuple] = None
        magnus_rpm:  Optional[float] = None
        axis_confidence: float = 0.0

        _ball_area = math.pi * config.BALL_RADIUS_M ** 2
        K_dyn = 0.5 * config.AIR_DENSITY * _ball_area * v_mag ** 2 / config.BALL_MASS_KG

        if f_mag > 0.5 and v_mag > 5.0:
            axis_raw  = np.cross(v_vec, f_vec)
            axis_norm = float(np.linalg.norm(axis_raw))
            if axis_norm > 0:
                magnus_axis = tuple(float(x) for x in axis_raw / axis_norm)

            magnus_rpm = max(0.0, (f_mag - config.MAGNUS_CL_CONST * K_dyn) * v_mag / (
                config.MAGNUS_CL_SLOPE * config.BALL_RADIUS_M * K_dyn) * 60.0 / (2.0 * math.pi))

            # Axis confidence: how reliably can we determine the axis direction?
            # Scales with Magnus force relative to the noise floor (~0.5 m/s²).
            # A pitch with 5+ m/s² force gives essentially perfect axis resolution;
            # a gyroball at 0.2 m/s² gives noise. Saturates at 1.0 above 4 m/s².
            axis_confidence = min(1.0, max(0.0, (f_mag - 0.5) / 3.5))

            log.info("Magnus spin: %.0f rpm  axis=(%.2f, %.2f, %.2f)  axis_conf=%.2f",
                     magnus_rpm, *(magnus_axis or (0, 0, 0)), axis_confidence)

        # Hit ball travels away from camera (+Z); pitch comes toward it (-Z).
        is_hit = metrics.vz0 > 1.0

        # ── Spin: hit vs pitch paths ──────────────────────────────────────────
        # Hits: seam tracking is unreliable (ball shrinks as it recedes; only
        #   ~20 usable frames vs ~90 for pitches). Magnus force inversion from
        #   the 3-D trajectory is the sole reliable source. The reported RPM is
        #   the transverse (active) component; gyro fraction is indeterminate.
        # Pitches: seam tracking is primary; Magnus assists axis / rate.
        _CAM_LOS = (0.0, 0.0, 1.0)   # camera looks in +Z (toward pitcher)
        spin: Optional[SpinMeasurement] = None

        if is_hit:
            if magnus_axis is not None and magnus_rpm is not None:
                spin = SpinMeasurement(
                    spin_rate_rpm   = round(magnus_rpm, 0),
                    spin_axis       = magnus_axis,
                    spin_efficiency = 1.0,   # reported RPM is already transverse-only
                    frames_analyzed = 0,
                    confidence      = round(min(0.8, axis_confidence + 0.2), 2),
                    axis_confidence = round(axis_confidence, 3),
                )
                spin_source = 'magnus'
        elif magnus_axis is not None:
            s0 = self._seam.compute_spin_with_axis(magnus_axis, _CAM_LOS)
            s1 = (self._seam1.compute_spin_with_axis(magnus_axis, _CAM_LOS)
                  if not use_spin_cam else None)

            if s0 is not None and s1 is not None:
                w0, w1 = s0.confidence, s1.confidence
                avg_rpm = (s0.spin_rate_rpm * w0 + s1.spin_rate_rpm * w1) / (w0 + w1)
                # Scale confidence down when the two cameras disagree substantially.
                # 12% relative disagreement → confidence halved; >12% → approaches 0.1.
                rpm_diff_frac = abs(s0.spin_rate_rpm - s1.spin_rate_rpm) / max(avg_rpm, 1.0)
                agreement = max(0.1, 1.0 - rpm_diff_frac / 0.12)
                fused_confidence = (w0 + w1) / 2 * agreement
                spin = dataclasses.replace(
                    s0,
                    spin_rate_rpm   = round(avg_rpm, 0),
                    frames_analyzed = s0.frames_analyzed + s1.frames_analyzed,
                    confidence      = round(fused_confidence, 3),
                )
                log.debug("Dual-cam spin: cam0=%.0f rpm  cam1=%.0f rpm  "
                          "diff=%.1f%%  agreement=%.2f",
                          s0.spin_rate_rpm, s1.spin_rate_rpm,
                          rpm_diff_frac * 100, agreement)
            else:
                spin = s0 or s1

            if spin is not None and magnus_rpm is not None:
                # Seam integration is primary; Magnus is a light sanity check.
                w_seam, w_mag = spin.confidence, 0.3
                blended = (spin.spin_rate_rpm * w_seam + magnus_rpm * w_mag) / (w_seam + w_mag)
                spin = dataclasses.replace(
                    spin,
                    spin_rate_rpm   = round(blended, 0),
                    axis_confidence = round(axis_confidence, 3),
                )
                spin_source = 'axis-corrected'

            # ── Analytical gyro override ──────────────────────────────────────
            # Use dot(magnus_axis, v_hat) to derive gyro angle analytically.
            # This is more reliable than the variance estimate inside
            # compute_spin_with_axis() when axis_confidence is high enough.
            if spin is not None and magnus_axis is not None and axis_confidence >= 0.35:
                v_hat    = v_vec / (v_mag + 1e-9)
                ma       = np.array(magnus_axis, dtype=float)
                raw_dot  = float(np.dot(ma, v_hat))
                gyro_sin = min(1.0, abs(raw_dot))
                gyro_deg = math.copysign(math.degrees(math.asin(gyro_sin)), raw_dot)
                active_frac = math.sqrt(max(0.0, 1.0 - gyro_sin ** 2))
                if active_frac > 0.15:  # don't amplify noise for near-pure gyroballs
                    old_rpm = spin.spin_rate_rpm
                    rpm_corrected = spin.spin_rate_rpm * spin.spin_efficiency / active_frac
                    spin = dataclasses.replace(
                        spin,
                        spin_rate_rpm   = round(rpm_corrected, 0),
                        spin_efficiency = round(active_frac, 3),
                        gyro_angle_deg  = round(gyro_deg, 1),
                    )
                    log.info("Analytical gyro: gyro=%.1f°  active=%.2f  "
                             "rpm %.0f → %.0f",
                             gyro_deg, active_frac, old_rpm, rpm_corrected)
            elif spin is None and magnus_rpm is not None:
                # Near-pure gyro or no seam data — Magnus rate only.
                # Gyroball: axis_confidence will be near 0, flagging unreliable tilt.
                spin = SpinMeasurement(
                    spin_rate_rpm   = round(magnus_rpm, 0),
                    spin_axis       = magnus_axis,
                    spin_efficiency = 0.0,
                    frames_analyzed = 0,
                    confidence      = 0.5,
                    axis_confidence = round(axis_confidence, 3),
                )
                spin_source = 'magnus'
        else:
            # No Magnus axis (weak trajectory curvature) — uncorrected seam (pitches only).
            s0 = self._seam.compute_spin()
            s1 = self._seam1.compute_spin() if not use_spin_cam else None
            if s0 is not None and s1 is not None:
                w0, w1 = s0.confidence, s1.confidence
                avg_rpm = (s0.spin_rate_rpm * w0 + s1.spin_rate_rpm * w1) / (w0 + w1)
                rpm_diff_frac = abs(s0.spin_rate_rpm - s1.spin_rate_rpm) / max(avg_rpm, 1.0)
                agreement = max(0.1, 1.0 - rpm_diff_frac / 0.12)
                spin = dataclasses.replace(
                    s0,
                    spin_rate_rpm   = round(avg_rpm, 0),
                    frames_analyzed = s0.frames_analyzed + s1.frames_analyzed,
                    confidence      = round((w0 + w1) / 2 * agreement, 3),
                )
            else:
                spin = s0 or s1

        if spin:
            log.info(
                "Spin [%s]: %.0f rpm  axis=(%.2f, %.2f, %.2f)  eff=%.2f  conf=%.2f  frames=%d",
                spin_source, spin.spin_rate_rpm, *spin.spin_axis,
                spin.spin_efficiency, spin.confidence, spin.frames_analyzed,
            )
        else:
            log.info("Spin [%s]: insufficient seam data", spin_source)

        carry_str = (
            f"  CARRY={carry_distance_m:.1f} m ({carry_distance_m * 3.281:.0f} ft) [{carry_source}]"
            if carry_distance_m is not None else "  CARRY=—"
        )
        log.info(
            "EV=%.1f mph [%s]  LA=%.1f°  SA=%.1f°%s  residual=%.2f mm  "
            "latency=%.0f ms  detection=%.0f%%  fit=%d pts (%d rejected)",
            metrics.exit_velocity_mph, ev_source,
            metrics.launch_angle_deg, metrics.spray_angle_deg,
            carry_str,
            metrics.fit_residual_mm, metrics.processing_latency_ms,
            detect_rate * 100,
            metrics.points_used, metrics.points_rejected,
        )

        M_PER_FT = 0.3048
        payload = {
            "type":               "measurement",
            "exitVelocity":       metrics.exit_velocity_mph,
            "launchAngle":        metrics.launch_angle_deg,
            "sprayAngle":         metrics.spray_angle_deg,
            "fitResidualMm":      metrics.fit_residual_mm,
            "latencyMs":          metrics.processing_latency_ms,
            "detectRate":         round(detect_rate, 3),
            "pointsUsed":         metrics.points_used,
            "pointsRejected":     metrics.points_rejected,
            "evSource":           ev_source,
            "radarVelocityMps":   round(radar_velocity_mps, 3) if radar_velocity_mps is not None else None,
            "pitchVelocity":      pitch_velocity_mph,   # mph, from OPS243 inbound reading
            "carryDistanceM":     carry_distance_m,     # meters, from OPS243 FMCW range
            # Ball position at the τ=0 launch state (trajectory fit extrapolation).
            # For hits this is the contact point; for pitches this is the release point.
            "contactXFt":         round(metrics.release_x / M_PER_FT, 2),
            "contactYFt":         round(metrics.release_y / M_PER_FT, 2),
            "trajectory":         [
                {"x": p.x, "y": p.y, "z": p.z, "t": p.timestamp}
                for p in metrics.trajectory
            ],
        }

        if spin is not None:
            payload["spin"] = {
                "rpm":            spin.spin_rate_rpm,
                "axis":           list(spin.spin_axis),
                "efficiency":     spin.spin_efficiency,
                "confidence":     spin.confidence,
                "axisConfidence": spin.axis_confidence,
                "gyroDeg":        spin.gyro_angle_deg,
                "framesUsed":     spin.frames_analyzed,
                "source":         spin_source,
            }

        # ── Trackman-style pitch metrics ─────────────────────────────────────
        # Always compute (cheap forward integration). Returns None if the
        # trajectory can't be a pitch — e.g. ball travelling AWAY from plate,
        # which is the batted-ball case. So this populates on pitches and
        # stays absent on hits, with no session-mode flag needed in pipeline.
        pitch = compute_pitch_metrics(
            metrics,
            spin_rate_rpm   = spin.spin_rate_rpm if spin else None,
            spin_axis       = spin.spin_axis     if spin else None,
            spin_efficiency = spin.spin_efficiency if spin else None,
        )
        if pitch is not None:
            payload["pitch"] = pitch_metrics_to_dict(pitch)
            log.info(
                "Pitch: release=%.1f mph  plate=%.1f mph  VB=%.1f in  HB=%.1f in  "
                "ext=%.1f ft  relH=%.1f ft  tilt=%s",
                pitch.release_speed_mph, pitch.plate_speed_mph,
                pitch.vertical_break_in, pitch.horizontal_break_in,
                pitch.extension_ft, pitch.release_height_ft,
                pitch.spin_tilt or "—",
            )

        self._server.broadcast(payload)
        self._server.broadcast({"type": "status", "state": "armed"})
