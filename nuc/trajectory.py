"""
Robust ballistic least-squares fit + launch metric extraction.

The fitter regresses the whole triangulated point cloud against a
gravity-corrected polynomial model per axis:

    x(τ) = x0 + vx·τ + ½ax·τ²          (ax captures drag)
    y(τ) + ½g·τ² = y0 + vy·τ + ½ay·τ²  (gravity removed first, ay = drag only)
    z(τ) = z0 + vz·τ + ½az·τ²

with iterative outlier rejection (3σ MAD gate), then reads the launch
velocity from the linear coefficients at τ = 0 (first detection).

This replaces the previous approach of differencing the first two points,
whose velocity error was ~(triangulation noise / frame interval) — about
±10 mph at 5 mm noise and 120 fps. A least-squares fit over N points
shrinks that by roughly √(N³)/√12 for the velocity term.
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

import config
from triangulate import Point3D

M_S_TO_MPH = 2.23694

# Pre-computed drag coefficient  (1/2 * rho * Cd * A / m) — used by tests and
# kept for reference; the quadratic fit absorbs drag without needing it.
_BALL_AREA = math.pi * (config.BALL_DIAMETER_M / 2) ** 2
DRAG_K = (
    0.5 * config.AIR_DENSITY * config.DRAG_COEFF * _BALL_AREA / config.BALL_MASS_KG
)

# ── Fit tuning ────────────────────────────────────────────────────────────────
_MIN_POINTS        = 3      # absolute minimum to attempt a fit
_QUADRATIC_MIN_N   = 8      # need this many points before adding drag terms
_OUTLIER_SIGMA     = 3.0    # MAD-based rejection gate
_OUTLIER_FLOOR_M   = 0.010  # never reject inside 10 mm — that's just noise
_MAX_REJECT_ROUNDS = 3


@dataclass
class LaunchMetrics:
    exit_velocity_mph: float
    launch_angle_deg: float
    spray_angle_deg: float
    fit_residual_mm: float
    processing_latency_ms: float
    trajectory: List[Point3D] = field(default_factory=list)
    points_used: int = 0
    points_rejected: int = 0


class TrajectoryFitter:
    """
    Fits a ballistic model to an ordered list of 3D points and returns
    launch metrics extracted from the fitted velocity at first detection.
    """

    def fit(self, points: List[Point3D], latency_ms: float) -> Optional[LaunchMetrics]:
        if len(points) < _MIN_POINTS:
            return None

        points = sorted(points, key=lambda p: p.timestamp)

        t = np.array([p.timestamp for p in points], dtype=np.float64)
        tau = t - t[0]
        # Guard against duplicate/garbage timestamps collapsing the design matrix
        if tau[-1] <= 0:
            return None

        obs = np.array([[p.x, p.y, p.z] for p in points], dtype=np.float64)

        # Remove known gravity from y so the quadratic term only has to absorb
        # drag (small) — this keeps low-N linear fits honest too.
        g_corr = 0.5 * config.GRAVITY_M_S2 * tau ** 2
        obs_w = obs.copy()
        obs_w[:, 1] += g_corr

        degree = 2 if len(points) >= _QUADRATIC_MIN_N else 1
        cols = [np.ones_like(tau), tau] + ([tau ** 2] if degree == 2 else [])
        A = np.column_stack(cols)

        # ── Iterative robust fit ─────────────────────────────────────────────
        mask = np.ones(len(points), dtype=bool)
        coef = None
        for _ in range(_MAX_REJECT_ROUNDS):
            coef, *_ = np.linalg.lstsq(A[mask], obs_w[mask], rcond=None)
            resid = np.linalg.norm(obs_w - A @ coef, axis=1)

            # MAD-based sigma is robust to the very outliers we're hunting
            med = float(np.median(resid[mask]))
            mad = float(np.median(np.abs(resid[mask] - med)))
            sigma = max(1.4826 * mad, 1e-6)
            gate = max(_OUTLIER_SIGMA * sigma, _OUTLIER_FLOOR_M)

            new_mask = resid <= gate
            if new_mask.sum() < _MIN_POINTS:
                break  # rejection went too far — keep previous mask/fit
            if np.array_equal(new_mask, mask):
                break
            mask = new_mask
        assert coef is not None

        # Refit on the final inlier set so coef matches mask
        coef, *_ = np.linalg.lstsq(A[mask], obs_w[mask], rcond=None)
        resid = np.linalg.norm(obs_w - A @ coef, axis=1)

        # ── Launch metrics from fitted velocity at τ = 0 ─────────────────────
        vx0, vy0, vz0 = coef[1]  # linear coefficients per axis
        horiz_speed = math.sqrt(vx0 ** 2 + vz0 ** 2)
        total_speed = math.sqrt(vx0 ** 2 + vy0 ** 2 + vz0 ** 2)

        exit_vel_mph = total_speed * M_S_TO_MPH
        launch_angle = math.degrees(math.atan2(vy0, horiz_speed))
        spray_angle  = math.degrees(math.atan2(vx0, vz0))

        inlier_resid = resid[mask]
        residual_mm = float(np.sqrt(np.mean(inlier_resid ** 2))) * 1000.0

        # ── Smoothed trajectory: fitted model at inlier timestamps ──────────
        fitted = A @ coef
        fitted[:, 1] -= g_corr  # restore gravity to y
        smoothed = [
            Point3D(x=float(fitted[i, 0]), y=float(fitted[i, 1]),
                    z=float(fitted[i, 2]), timestamp=float(t[i]))
            for i in range(len(points)) if mask[i]
        ]
        # Only keep points travelling toward the pitcher (z ≥ 0)
        smoothed = [p for p in smoothed if p.z >= 0]

        return LaunchMetrics(
            exit_velocity_mph=round(exit_vel_mph, 1),
            launch_angle_deg=round(launch_angle, 1),
            spray_angle_deg=round(spray_angle, 1),
            fit_residual_mm=round(residual_mm, 2),
            processing_latency_ms=round(latency_ms, 1),
            trajectory=smoothed,
            points_used=int(mask.sum()),
            points_rejected=int(len(points) - mask.sum()),
        )
