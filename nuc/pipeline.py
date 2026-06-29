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
    def __init__(self, server, ops243=None, spin_ring=None) -> None:
        self._server       = server
        self._ops243       = ops243      # optional OPS243Reader (OmniPreSense)
        self._spin_ring    = spin_ring   # optional SpinFrameRing (640 fps spin cam)
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
            ops_ev_mph    = self._ops243.latest_ev_mph()
            ops_pitch_mph = self._ops243.latest_pitch_mph()
            ops_range_m   = self._ops243.latest_range_m()
            self._ops243.clear()

            if ops_pitch_mph is not None:
                pitch_velocity_mph = round(ops_pitch_mph, 2)

            if ops_range_m is not None:
                carry_distance_m = round(ops_range_m, 3)
                carry_source     = 'radar'

            if ops_ev_mph is not None:
                # The OPS243 measures radial velocity along its bore axis. With
                # the unit mounted behind home plate the radial component equals
                # v_true · cos(spray) · cos(launch). Divide it back out so the
                # agreement gate compares true speeds rather than projections.
                # Guard: if the ball is hit more than 70° off-axis the geometry
                # is too oblique for the correction to be reliable.
                spray_rad  = math.radians(metrics.spray_angle_deg)
                launch_rad = math.radians(metrics.launch_angle_deg)
                cos_factor = math.cos(spray_rad) * math.cos(launch_rad)
                if abs(cos_factor) >= math.cos(math.radians(70)):
                    ops_ev_mph = ops_ev_mph / cos_factor
                    log.debug("OPS243 cosine correction: ×%.3f (spray=%.1f° launch=%.1f°)",
                              1.0 / cos_factor, metrics.spray_angle_deg, metrics.launch_angle_deg)
                else:
                    log.info("OPS243 EV skipped — spray %.1f° + launch %.1f° too oblique to radar",
                             metrics.spray_angle_deg, metrics.launch_angle_deg)
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

        # ── Spin: axis-first gyro-corrected seam integration ─────────────────
        # Camera behind home plate looks toward the pitcher (+Z world frame).
        # compute_spin_with_axis() integrates total seam rotation over the
        # full flight and divides by sin(angle between spin_axis and LOS) to
        # recover the true RPM regardless of pitch type. Falls back to the
        # uncorrected compute_spin() when no Magnus axis is available, and to
        # Magnus-only when the pitch is near-pure gyro (slider/sweeper extreme).
        _CAM_LOS = (0.0, 0.0, 1.0)   # camera looks in +Z (toward pitcher)
        spin: Optional[SpinMeasurement] = None

        if magnus_axis is not None:
            s0 = self._seam.compute_spin_with_axis(magnus_axis, _CAM_LOS)
            s1 = (self._seam1.compute_spin_with_axis(magnus_axis, _CAM_LOS)
                  if not use_spin_cam else None)

            if s0 is not None and s1 is not None:
                w0, w1 = s0.confidence, s1.confidence
                avg_rpm = (s0.spin_rate_rpm * w0 + s1.spin_rate_rpm * w1) / (w0 + w1)
                spin = dataclasses.replace(
                    s0,
                    spin_rate_rpm   = round(avg_rpm, 0),
                    frames_analyzed = s0.frames_analyzed + s1.frames_analyzed,
                    confidence      = (w0 + w1) / 2,
                )
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
            # No Magnus axis (weak trajectory curvature) — uncorrected seam.
            s0 = self._seam.compute_spin()
            s1 = self._seam1.compute_spin() if not use_spin_cam else None
            if s0 is not None and s1 is not None:
                w0, w1 = s0.confidence, s1.confidence
                avg_rpm = (s0.spin_rate_rpm * w0 + s1.spin_rate_rpm * w1) / (w0 + w1)
                spin = dataclasses.replace(
                    s0,
                    spin_rate_rpm   = round(avg_rpm, 0),
                    frames_analyzed = s0.frames_analyzed + s1.frames_analyzed,
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
