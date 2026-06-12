"""
Core tracking pipeline — runs on the NUC.

Receives flushed frame windows from FrameBuffer, runs:
  - ROI ball tracking (both cameras)
  - Seam-based spin estimation (camera 0 — closest to ball at contact)
  - Stereo triangulation
  - Robust ballistic trajectory fitting
  - Launch metric calculation
and broadcasts results via WebSocket.
"""

import dataclasses
import logging
import time
from typing import List, Optional

import config
from capture import FramePair
from seam_tracker import SeamTracker, SpinMeasurement
from tracker import BallTracker
from trajectory import TrajectoryFitter, LaunchMetrics
from triangulate import Point3D, Triangulator

log = logging.getLogger(__name__)

MPS_TO_MPH = 2.23694


class TrackingPipeline:
    def __init__(self, server, radar=None) -> None:
        self._server       = server
        self._radar        = radar   # optional IWR6843Reader
        self._tracker0     = BallTracker()
        self._tracker1    = BallTracker()
        self._seam        = SeamTracker()
        self._triangulator = Triangulator()
        self._fitter       = TrajectoryFitter()

        if not self._triangulator.is_calibrated:
            log.warning(
                "No calibration file found (%s). "
                "Run calibrate.py first for accurate measurements.",
                config.CALIBRATION_FILE,
            )

    def process(self, frames: List[FramePair], trigger_time: float) -> None:
        t_start = time.monotonic()
        log.info("Processing %d frame pairs …", len(frames))

        self._tracker0.reset()
        self._tracker1.reset()
        self._seam.reset()

        points: List[Point3D] = []

        for frame_idx, pair in enumerate(frames):
            d0 = self._tracker0.update(pair.left,  frame_idx)
            d1 = self._tracker1.update(pair.right, frame_idx)

            # Feed seam tracker from camera 0 whenever ball is detected
            if d0 is not None:
                self._seam.process_frame(pair.left, d0, pair.timestamp, frame_idx)

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
        spin: Optional[SpinMeasurement] = self._seam.compute_spin()
        if spin:
            log.info(
                "Spin: %.0f rpm  axis=(%.2f, %.2f, %.2f)  eff=%.2f  conf=%.2f  frames=%d",
                spin.spin_rate_rpm, *spin.spin_axis,
                spin.spin_efficiency, spin.confidence, spin.frames_analyzed,
            )
        else:
            log.info("Spin: insufficient seam data")

        # ── Trajectory + metrics ─────────────────────────────────────────────
        latency_ms = (time.monotonic() - t_start) * 1000.0
        metrics: Optional[LaunchMetrics] = self._fitter.fit(points, latency_ms)

        if metrics is None:
            log.warning("Not enough 3D points (%d) — need at least 3", len(points))
            self._server.broadcast({"type": "status", "state": "armed"})
            return

        detect_rate = len(points) / max(len(frames), 1)

        # ── Radar cross-check ─────────────────────────────────────────────────
        # If a radar frame is available, find the highest-SNR, fast-enough
        # point and compare against the camera-derived exit velocity.
        # If they agree within RADAR_AGREE_FRACTION, prefer the radar value
        # (Doppler is more direct than trajectory fitting).
        radar_velocity_mps: Optional[float] = None
        ev_source = 'camera'

        if self._radar is not None:
            frame = self._radar.latest_frame()
            if frame and frame.points:
                best = max(
                    (p for p in frame.points
                     if abs(p.vel) >= config.RADAR_TRIGGER_VELOCITY_MPS
                     and p.snr >= config.RADAR_MIN_SNR_DB),
                    key=lambda p: p.snr,
                    default=None,
                )
                if best is not None:
                    radar_mph = abs(best.vel) * MPS_TO_MPH
                    cam_mph   = metrics.exit_velocity_mph
                    agree     = abs(radar_mph - cam_mph) / max(cam_mph, 1) <= config.RADAR_AGREE_FRACTION
                    radar_velocity_mps = abs(best.vel)
                    if agree:
                        metrics = dataclasses.replace(metrics, exit_velocity_mph=round(radar_mph, 1))
                        ev_source = 'radar'
                        log.info("Radar EV %.1f mph (camera=%.1f mph, Δ=%.1f%%)",
                                 radar_mph, cam_mph,
                                 100 * abs(radar_mph - cam_mph) / max(cam_mph, 1))
                    else:
                        log.info(
                            "Radar EV %.1f mph disagrees with camera %.1f mph "
                            "(Δ=%.1f%% > %.0f%% tolerance) — keeping camera",
                            radar_mph, cam_mph,
                            100 * abs(radar_mph - cam_mph) / max(cam_mph, 1),
                            config.RADAR_AGREE_FRACTION * 100,
                        )

        log.info(
            "EV=%.1f mph [%s]  LA=%.1f°  SA=%.1f°  residual=%.2f mm  "
            "latency=%.0f ms  detection=%.0f%%  fit=%d pts (%d rejected)",
            metrics.exit_velocity_mph, ev_source,
            metrics.launch_angle_deg, metrics.spray_angle_deg,
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
            "trajectory":         [
                {"x": p.x, "y": p.y, "z": p.z, "t": p.timestamp}
                for p in metrics.trajectory
            ],
        }

        if spin is not None:
            payload["spin"] = {
                "rpm":          spin.spin_rate_rpm,
                "axis":         list(spin.spin_axis),
                "efficiency":   spin.spin_efficiency,
                "confidence":   spin.confidence,
                "framesUsed":   spin.frames_analyzed,
            }

        self._server.broadcast(payload)
        self._server.broadcast({"type": "status", "state": "armed"})
